#!/bin/bash

# Production Database Backup Script for Sierra Sync Platform
# This script performs automated backups with encryption and S3 upload

set -e

# Load environment variables
source /etc/sierra-sync/.env.production

# Configuration
BACKUP_DIR="/var/backups/sierra-sync"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="sierra_sync_backup_${TIMESTAMP}"
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
MAX_PARALLEL_JOBS=4

# Logging
LOG_FILE="/var/log/sierra-sync/backup.log"
METRICS_FILE="/var/log/sierra-sync/backup-metrics.json"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

# Error handling
error_exit() {
    echo -e "${RED}[ERROR] $1${NC}" | tee -a "$LOG_FILE"
    send_alert "BACKUP_FAILED" "$1"
    exit 1
}

# Send alerts
send_alert() {
    local alert_type=$1
    local message=$2
    
    # Send to monitoring system
    curl -X POST "${MONITORING_WEBHOOK_URL}" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"$alert_type\",\"message\":\"$message\",\"timestamp\":\"$(date -Iseconds)\"}" \
        2>/dev/null || true
    
    # Send to Slack if configured
    if [ -n "$SLACK_WEBHOOK_URL" ]; then
        curl -X POST "$SLACK_WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"text\":\":warning: Backup Alert: $message\"}" \
            2>/dev/null || true
    fi
}

# Check prerequisites
check_prerequisites() {
    log "Checking prerequisites..."
    
    # Check required tools
    for tool in pg_dump aws gpg jq parallel; do
        if ! command -v $tool &> /dev/null; then
            error_exit "$tool is not installed"
        fi
    done
    
    # Check disk space (need at least 10GB free)
    available_space=$(df "$BACKUP_DIR" | awk 'NR==2 {print $4}')
    if [ "$available_space" -lt 10485760 ]; then
        error_exit "Insufficient disk space for backup"
    fi
    
    # Check database connectivity
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1" &> /dev/null || \
        error_exit "Cannot connect to database"
    
    # Create backup directory if it doesn't exist
    mkdir -p "$BACKUP_DIR"
    
    log "Prerequisites check passed"
}

# Perform database backup
backup_database() {
    log "Starting database backup..."
    
    local backup_file="${BACKUP_DIR}/${BACKUP_NAME}.sql"
    local start_time=$(date +%s)
    
    # Perform backup with parallel jobs
    PGPASSWORD="$DB_PASSWORD" pg_dump \
        -h "$DB_HOST" \
        -p "$DB_PORT" \
        -U "$DB_USER" \
        -d "$DB_NAME" \
        -j "$MAX_PARALLEL_JOBS" \
        -Fd \
        -f "${backup_file}.dir" \
        --verbose \
        --no-owner \
        --no-privileges \
        --if-exists \
        --clean \
        2>&1 | tee -a "$LOG_FILE"
    
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        error_exit "Database backup failed"
    fi
    
    # Convert to compressed format
    log "Compressing backup..."
    tar -czf "${backup_file}.tar.gz" -C "$BACKUP_DIR" "${BACKUP_NAME}.sql.dir"
    rm -rf "${backup_file}.dir"
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    local size=$(stat -c%s "${backup_file}.tar.gz")
    
    log "Database backup completed in ${duration}s, size: $(numfmt --to=iec-i --suffix=B $size)"
    
    echo "${backup_file}.tar.gz"
}

# Backup application files
backup_application() {
    log "Backing up application files..."
    
    local app_backup="${BACKUP_DIR}/${BACKUP_NAME}_app.tar.gz"
    
    tar -czf "$app_backup" \
        --exclude='node_modules' \
        --exclude='.git' \
        --exclude='*.log' \
        --exclude='dist' \
        --exclude='build' \
        /opt/sierra-sync/src \
        /opt/sierra-sync/config \
        /opt/sierra-sync/n8n-workflows \
        2>&1 | tee -a "$LOG_FILE"
    
    if [ ${PIPESTATUS[0]} -ne 0 ]; then
        log "Warning: Application backup had errors"
    fi
    
    log "Application backup completed: $(numfmt --to=iec-i --suffix=B $(stat -c%s "$app_backup"))"
    
    echo "$app_backup"
}

# Encrypt backup
encrypt_backup() {
    local file=$1
    log "Encrypting backup file: $(basename "$file")"
    
    gpg --batch --yes \
        --passphrase "$BACKUP_ENCRYPTION_KEY" \
        --cipher-algo AES256 \
        --symmetric \
        --output "${file}.gpg" \
        "$file"
    
    if [ $? -eq 0 ]; then
        rm "$file"  # Remove unencrypted file
        log "Encryption completed"
        echo "${file}.gpg"
    else
        error_exit "Encryption failed for $file"
    fi
}

# Upload to S3
upload_to_s3() {
    local file=$1
    local s3_path="s3://${BACKUP_S3_BUCKET}/$(date +%Y/%m/%d)/$(basename "$file")"
    
    log "Uploading to S3: $s3_path"
    
    aws s3 cp "$file" "$s3_path" \
        --storage-class STANDARD_IA \
        --server-side-encryption AES256 \
        --metadata "backup-date=${TIMESTAMP},retention-days=${RETENTION_DAYS}" \
        2>&1 | tee -a "$LOG_FILE"
    
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        log "Upload completed successfully"
        return 0
    else
        error_exit "S3 upload failed"
    fi
}

# Verify backup integrity
verify_backup() {
    local file=$1
    log "Verifying backup integrity..."
    
    # Check if file exists and is not empty
    if [ ! -s "$file" ]; then
        error_exit "Backup file is empty or doesn't exist: $file"
    fi
    
    # Test decryption (don't output decrypted content)
    gpg --batch --yes \
        --passphrase "$BACKUP_ENCRYPTION_KEY" \
        --decrypt "$file" > /dev/null 2>&1
    
    if [ $? -ne 0 ]; then
        error_exit "Backup verification failed - cannot decrypt"
    fi
    
    log "Backup verification passed"
}

# Clean old backups
cleanup_old_backups() {
    log "Cleaning up old backups..."
    
    # Clean local backups older than 7 days
    find "$BACKUP_DIR" -name "*.gpg" -mtime +7 -delete
    
    # Clean S3 backups older than retention period
    local cutoff_date=$(date -d "${RETENTION_DAYS} days ago" +%Y-%m-%d)
    
    aws s3api list-objects-v2 \
        --bucket "$BACKUP_S3_BUCKET" \
        --query "Contents[?LastModified<='${cutoff_date}'].Key" \
        --output text | \
    while read -r key; do
        if [ -n "$key" ]; then
            log "Deleting old backup: $key"
            aws s3 rm "s3://${BACKUP_S3_BUCKET}/${key}"
        fi
    done
    
    log "Cleanup completed"
}

# Record metrics
record_metrics() {
    local status=$1
    local duration=$2
    local size=$3
    local error_message=$4
    
    cat > "$METRICS_FILE" <<EOF
{
    "timestamp": "$(date -Iseconds)",
    "status": "$status",
    "duration_seconds": $duration,
    "backup_size_bytes": $size,
    "error": "$error_message",
    "retention_days": $RETENTION_DAYS,
    "database": "$DB_NAME",
    "host": "$(hostname)"
}
EOF
    
    # Send metrics to monitoring
    if [ -n "$MONITORING_API_URL" ]; then
        curl -X POST "${MONITORING_API_URL}/metrics/backup" \
            -H "Content-Type: application/json" \
            -H "X-API-Key: ${MONITORING_API_KEY}" \
            -d @"$METRICS_FILE" \
            2>/dev/null || true
    fi
}

# Test restore (optional)
test_restore() {
    local backup_file=$1
    log "Testing backup restore (dry run)..."
    
    # Create test database
    PGPASSWORD="$DB_PASSWORD" createdb \
        -h "$DB_HOST" \
        -U "$DB_USER" \
        "test_restore_${TIMESTAMP}" \
        2>&1 | tee -a "$LOG_FILE"
    
    # Decrypt and restore to test database
    gpg --batch --yes \
        --passphrase "$BACKUP_ENCRYPTION_KEY" \
        --decrypt "$backup_file" | \
    tar -xzO | \
    PGPASSWORD="$DB_PASSWORD" psql \
        -h "$DB_HOST" \
        -U "$DB_USER" \
        -d "test_restore_${TIMESTAMP}" \
        &> /dev/null
    
    if [ $? -eq 0 ]; then
        log "Test restore successful"
        # Drop test database
        PGPASSWORD="$DB_PASSWORD" dropdb \
            -h "$DB_HOST" \
            -U "$DB_USER" \
            "test_restore_${TIMESTAMP}" \
            2>&1 | tee -a "$LOG_FILE"
    else
        log "Warning: Test restore failed"
    fi
}

# Main backup process
main() {
    local start_time=$(date +%s)
    local status="SUCCESS"
    local error_message=""
    local total_size=0
    
    log "========================================="
    log "Starting backup process at $(date)"
    log "========================================="
    
    # Trap errors
    trap 'error_exit "Backup process interrupted"' INT TERM
    
    # Check prerequisites
    check_prerequisites
    
    # Perform backups
    db_backup=$(backup_database) || error_exit "Database backup failed"
    app_backup=$(backup_application) || true  # Don't fail on app backup
    
    # Encrypt backups
    encrypted_db=$(encrypt_backup "$db_backup") || error_exit "Encryption failed"
    
    if [ -n "$app_backup" ] && [ -f "$app_backup" ]; then
        encrypted_app=$(encrypt_backup "$app_backup") || true
    fi
    
    # Verify backups
    verify_backup "$encrypted_db" || error_exit "Verification failed"
    
    # Upload to S3
    if [ "$BACKUP_ENABLED" = "true" ]; then
        upload_to_s3 "$encrypted_db" || error_exit "S3 upload failed"
        
        if [ -n "$encrypted_app" ] && [ -f "$encrypted_app" ]; then
            upload_to_s3 "$encrypted_app" || true
        fi
    fi
    
    # Test restore (optional)
    if [ "$TEST_RESTORE" = "true" ]; then
        test_restore "$encrypted_db"
    fi
    
    # Cleanup old backups
    cleanup_old_backups
    
    # Calculate metrics
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    total_size=$(stat -c%s "$encrypted_db" 2>/dev/null || echo 0)
    
    # Record success metrics
    record_metrics "$status" "$duration" "$total_size" "$error_message"
    
    log "========================================="
    log "Backup completed successfully in ${duration}s"
    log "Total size: $(numfmt --to=iec-i --suffix=B $total_size)"
    log "========================================="
    
    # Send success notification
    send_alert "BACKUP_SUCCESS" "Backup completed in ${duration}s, size: $(numfmt --to=iec-i --suffix=B $total_size)"
}

# Run main function
main "$@"