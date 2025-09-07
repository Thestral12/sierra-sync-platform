#!/bin/bash

# Sierra Sync Multi-Region Database Replication Manager
# Manages PostgreSQL read replicas across multiple AWS regions

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/sierra-sync/db-replication.log"
CONFIG_FILE="$SCRIPT_DIR/../config/database-replication.conf"

# Default values
PRIMARY_REGION="us-east-1"
SECONDARY_REGION="us-west-2"
TERTIARY_REGION="eu-west-1"
PRIMARY_INSTANCE="sierra-sync-primary"
SECONDARY_INSTANCE="sierra-sync-secondary"
TERTIARY_INSTANCE="sierra-sync-tertiary"

# Slack webhook for notifications
SLACK_WEBHOOK_URL="${SLACK_WEBHOOK_URL:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging function
log() {
    local level="$1"
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} [${level}] ${message}" | tee -a "$LOG_FILE"
}

info() {
    log "INFO" "${BLUE}$*${NC}"
}

warn() {
    log "WARN" "${YELLOW}$*${NC}"
}

error() {
    log "ERROR" "${RED}$*${NC}"
}

success() {
    log "SUCCESS" "${GREEN}$*${NC}"
}

# Load configuration if exists
if [[ -f "$CONFIG_FILE" ]]; then
    source "$CONFIG_FILE"
    info "Loaded configuration from $CONFIG_FILE"
fi

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

# Send Slack notification
send_slack_notification() {
    local message="$1"
    local color="${2:-good}"
    
    if [[ -n "$SLACK_WEBHOOK_URL" ]]; then
        curl -X POST -H 'Content-type: application/json' \
            --data "{\"text\":\"🗃️ Sierra Sync DB Replication: $message\", \"color\":\"$color\"}" \
            "$SLACK_WEBHOOK_URL" 2>/dev/null || true
    fi
}

# Check AWS CLI and credentials
check_aws_cli() {
    if ! command -v aws &> /dev/null; then
        error "AWS CLI not found. Please install AWS CLI."
        exit 1
    fi
    
    # Check credentials for each region
    local regions=("$PRIMARY_REGION" "$SECONDARY_REGION" "$TERTIARY_REGION")
    for region in "${regions[@]}"; do
        if ! aws sts get-caller-identity --region "$region" &>/dev/null; then
            error "AWS credentials not configured for region $region"
            exit 1
        fi
    done
    
    success "AWS CLI and credentials verified"
}

# Get RDS instance status
get_instance_status() {
    local instance_id="$1"
    local region="$2"
    
    aws rds describe-db-instances \
        --db-instance-identifier "$instance_id" \
        --region "$region" \
        --query 'DBInstances[0].DBInstanceStatus' \
        --output text 2>/dev/null || echo "not-found"
}

# Get replication lag
get_replica_lag() {
    local instance_id="$1"
    local region="$2"
    
    aws cloudwatch get-metric-statistics \
        --namespace AWS/RDS \
        --metric-name ReplicaLag \
        --dimensions Name=DBInstanceIdentifier,Value="$instance_id" \
        --start-time "$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
        --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --period 300 \
        --statistics Average \
        --region "$region" \
        --query 'Datapoints[0].Average' \
        --output text 2>/dev/null || echo "0"
}

# Monitor database health
monitor_health() {
    info "Starting database health monitoring..."
    
    # Primary instance health
    local primary_status=$(get_instance_status "$PRIMARY_INSTANCE" "$PRIMARY_REGION")
    info "Primary instance ($PRIMARY_REGION): $primary_status"
    
    if [[ "$primary_status" != "available" ]]; then
        error "Primary instance is not available: $primary_status"
        send_slack_notification "❌ Primary database is not available: $primary_status" "danger"
        return 1
    fi
    
    # Secondary replica health
    local secondary_status=$(get_instance_status "$SECONDARY_INSTANCE" "$SECONDARY_REGION")
    local secondary_lag=$(get_replica_lag "$SECONDARY_INSTANCE" "$SECONDARY_REGION")
    info "Secondary replica ($SECONDARY_REGION): $secondary_status, Lag: ${secondary_lag}s"
    
    if [[ "$secondary_status" != "available" ]]; then
        warn "Secondary replica is not available: $secondary_status"
        send_slack_notification "⚠️ Secondary replica is not available: $secondary_status" "warning"
    elif (( $(echo "$secondary_lag > 300" | bc -l) )); then
        warn "Secondary replica lag is high: ${secondary_lag}s"
        send_slack_notification "⚠️ Secondary replica lag is high: ${secondary_lag}s" "warning"
    fi
    
    # Tertiary replica health
    local tertiary_status=$(get_instance_status "$TERTIARY_INSTANCE" "$TERTIARY_REGION")
    local tertiary_lag=$(get_replica_lag "$TERTIARY_INSTANCE" "$TERTIARY_REGION")
    info "Tertiary replica ($TERTIARY_REGION): $tertiary_status, Lag: ${tertiary_lag}s"
    
    if [[ "$tertiary_status" != "available" ]]; then
        warn "Tertiary replica is not available: $tertiary_status"
        send_slack_notification "⚠️ Tertiary replica is not available: $tertiary_status" "warning"
    elif (( $(echo "$tertiary_lag > 300" | bc -l) )); then
        warn "Tertiary replica lag is high: ${tertiary_lag}s"
        send_slack_notification "⚠️ Tertiary replica lag is high: ${tertiary_lag}s" "warning"
    fi
    
    success "Health monitoring completed"
    return 0
}

# Create read replica
create_replica() {
    local source_db="$1"
    local replica_id="$2"
    local target_region="$3"
    local instance_class="${4:-db.r6g.large}"
    
    info "Creating read replica $replica_id in $target_region..."
    
    # Check if replica already exists
    if aws rds describe-db-instances \
        --db-instance-identifier "$replica_id" \
        --region "$target_region" &>/dev/null; then
        warn "Replica $replica_id already exists in $target_region"
        return 0
    fi
    
    # Get source DB ARN
    local source_arn=$(aws rds describe-db-instances \
        --db-instance-identifier "$source_db" \
        --region "$PRIMARY_REGION" \
        --query 'DBInstances[0].DBInstanceArn' \
        --output text)
    
    if [[ -z "$source_arn" ]]; then
        error "Failed to get source DB ARN for $source_db"
        return 1
    fi
    
    # Create the replica
    aws rds create-db-instance-read-replica \
        --db-instance-identifier "$replica_id" \
        --source-db-instance-identifier "$source_arn" \
        --db-instance-class "$instance_class" \
        --monitoring-interval 60 \
        --enable-performance-insights \
        --performance-insights-retention-period 7 \
        --enable-cloudwatch-logs-exports postgresql upgrade \
        --region "$target_region" \
        --tags Key=Name,Value="$replica_id" \
               Key=Environment,Value=production \
               Key=Role,Value=replica \
               Key=Region,Value="$target_region"
    
    if [[ $? -eq 0 ]]; then
        success "Read replica creation initiated for $replica_id"
        send_slack_notification "🚀 Read replica creation started: $replica_id in $target_region"
        
        # Wait for replica to be available
        info "Waiting for replica to become available..."
        aws rds wait db-instance-available \
            --db-instance-identifier "$replica_id" \
            --region "$target_region"
        
        success "Read replica $replica_id is now available"
        send_slack_notification "✅ Read replica is now available: $replica_id"
    else
        error "Failed to create read replica $replica_id"
        send_slack_notification "❌ Failed to create read replica: $replica_id" "danger"
        return 1
    fi
}

# Delete read replica
delete_replica() {
    local replica_id="$1"
    local region="$2"
    local skip_final_snapshot="${3:-false}"
    
    info "Deleting read replica $replica_id in $region..."
    
    local delete_args=(
        --db-instance-identifier "$replica_id"
        --region "$region"
    )
    
    if [[ "$skip_final_snapshot" == "true" ]]; then
        delete_args+=(--skip-final-snapshot)
    else
        delete_args+=(--final-db-snapshot-identifier "${replica_id}-final-snapshot-$(date +%Y%m%d%H%M%S)")
    fi
    
    aws rds delete-db-instance "${delete_args[@]}"
    
    if [[ $? -eq 0 ]]; then
        success "Read replica deletion initiated for $replica_id"
        send_slack_notification "🗑️ Read replica deletion started: $replica_id"
    else
        error "Failed to delete read replica $replica_id"
        send_slack_notification "❌ Failed to delete read replica: $replica_id" "danger"
        return 1
    fi
}

# Promote read replica to standalone instance
promote_replica() {
    local replica_id="$1"
    local region="$2"
    local backup_retention="${3:-30}"
    
    info "Promoting read replica $replica_id to standalone instance..."
    
    aws rds promote-read-replica \
        --db-instance-identifier "$replica_id" \
        --backup-retention-period "$backup_retention" \
        --region "$region"
    
    if [[ $? -eq 0 ]]; then
        success "Read replica promotion initiated for $replica_id"
        send_slack_notification "⬆️ Read replica promotion started: $replica_id"
        
        # Wait for promotion to complete
        info "Waiting for promotion to complete..."
        aws rds wait db-instance-available \
            --db-instance-identifier "$replica_id" \
            --region "$region"
        
        success "Read replica $replica_id has been promoted to standalone instance"
        send_slack_notification "✅ Read replica promoted successfully: $replica_id"
    else
        error "Failed to promote read replica $replica_id"
        send_slack_notification "❌ Failed to promote read replica: $replica_id" "danger"
        return 1
    fi
}

# Failover to replica (manual process)
failover_to_replica() {
    local target_replica="$1"
    local target_region="$2"
    
    warn "MANUAL FAILOVER PROCESS - This requires careful coordination!"
    info "Steps to failover to $target_replica in $target_region:"
    echo
    echo "1. Stop application traffic to primary database"
    echo "2. Wait for replication to catch up"
    echo "3. Promote replica: $0 promote-replica $target_replica $target_region"
    echo "4. Update application configuration to use new primary"
    echo "5. Create new replicas from promoted instance"
    echo "6. Resume application traffic"
    echo
    warn "This script does NOT perform automatic failover for safety reasons"
    
    send_slack_notification "⚠️ Manual failover process initiated for $target_replica" "warning"
}

# Generate replication status report
generate_status_report() {
    info "Generating replication status report..."
    
    local report_file="/tmp/sierra-sync-replication-report-$(date +%Y%m%d-%H%M%S).json"
    
    # Primary instance info
    local primary_info=$(aws rds describe-db-instances \
        --db-instance-identifier "$PRIMARY_INSTANCE" \
        --region "$PRIMARY_REGION" \
        --output json 2>/dev/null || echo '{}')
    
    # Secondary replica info
    local secondary_info=$(aws rds describe-db-instances \
        --db-instance-identifier "$SECONDARY_INSTANCE" \
        --region "$SECONDARY_REGION" \
        --output json 2>/dev/null || echo '{}')
    
    # Tertiary replica info
    local tertiary_info=$(aws rds describe-db-instances \
        --db-instance-identifier "$TERTIARY_INSTANCE" \
        --region "$TERTIARY_REGION" \
        --output json 2>/dev/null || echo '{}')
    
    # Get replication lag metrics
    local secondary_lag=$(get_replica_lag "$SECONDARY_INSTANCE" "$SECONDARY_REGION")
    local tertiary_lag=$(get_replica_lag "$TERTIARY_INSTANCE" "$TERTIARY_REGION")
    
    # Generate report
    cat > "$report_file" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "primary": {
    "instance_id": "$PRIMARY_INSTANCE",
    "region": "$PRIMARY_REGION",
    "details": $primary_info
  },
  "replicas": {
    "secondary": {
      "instance_id": "$SECONDARY_INSTANCE",
      "region": "$SECONDARY_REGION",
      "lag_seconds": $secondary_lag,
      "details": $secondary_info
    },
    "tertiary": {
      "instance_id": "$TERTIARY_INSTANCE",
      "region": "$TERTIARY_REGION",
      "lag_seconds": $tertiary_lag,
      "details": $tertiary_info
    }
  }
}
EOF
    
    success "Replication status report generated: $report_file"
    echo "Report location: $report_file"
    
    # Display summary
    echo
    info "=== REPLICATION STATUS SUMMARY ==="
    echo "Primary ($PRIMARY_REGION): $(get_instance_status "$PRIMARY_INSTANCE" "$PRIMARY_REGION")"
    echo "Secondary ($SECONDARY_REGION): $(get_instance_status "$SECONDARY_INSTANCE" "$SECONDARY_REGION"), Lag: ${secondary_lag}s"
    echo "Tertiary ($TERTIARY_REGION): $(get_instance_status "$TERTIARY_INSTANCE" "$TERTIARY_REGION"), Lag: ${tertiary_lag}s"
    echo "=================================="
}

# Setup monitoring (CloudWatch alarms)
setup_monitoring() {
    info "Setting up CloudWatch monitoring for replicas..."
    
    # Secondary replica monitoring
    aws cloudwatch put-metric-alarm \
        --alarm-name "sierra-sync-secondary-replica-lag" \
        --alarm-description "Monitor secondary replica lag" \
        --metric-name ReplicaLag \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 300 \
        --comparison-operator GreaterThanThreshold \
        --evaluation-periods 2 \
        --dimensions Name=DBInstanceIdentifier,Value="$SECONDARY_INSTANCE" \
        --region "$SECONDARY_REGION"
    
    # Tertiary replica monitoring
    aws cloudwatch put-metric-alarm \
        --alarm-name "sierra-sync-tertiary-replica-lag" \
        --alarm-description "Monitor tertiary replica lag" \
        --metric-name ReplicaLag \
        --namespace AWS/RDS \
        --statistic Average \
        --period 300 \
        --threshold 300 \
        --comparison-operator GreaterThanThreshold \
        --evaluation-periods 2 \
        --dimensions Name=DBInstanceIdentifier,Value="$TERTIARY_INSTANCE" \
        --region "$TERTIARY_REGION"
    
    success "CloudWatch monitoring alarms configured"
}

# Show usage information
usage() {
    cat << EOF
Sierra Sync Database Replication Manager

Usage: $0 [COMMAND] [OPTIONS]

Commands:
  health                           - Check health of all database instances
  monitor                         - Continuous health monitoring
  create-replica SOURCE REPLICA REGION [CLASS] - Create a new read replica
  delete-replica REPLICA REGION [SKIP_SNAPSHOT] - Delete a read replica
  promote-replica REPLICA REGION [RETENTION]    - Promote replica to standalone
  failover REPLICA REGION                       - Display manual failover steps
  status                                        - Generate status report
  setup-monitoring                              - Setup CloudWatch alarms

Examples:
  $0 health                       - Check health of all instances
  $0 create-replica sierra-sync-primary new-replica us-west-1
  $0 promote-replica sierra-sync-secondary us-west-2
  $0 status                       - Generate detailed status report

Environment Variables:
  SLACK_WEBHOOK_URL              - Slack webhook URL for notifications
  PRIMARY_REGION                 - Primary database region (default: us-east-1)
  SECONDARY_REGION               - Secondary replica region (default: us-west-2)
  TERTIARY_REGION                - Tertiary replica region (default: eu-west-1)

Configuration File: $CONFIG_FILE
Log File: $LOG_FILE
EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "health")
            check_aws_cli
            monitor_health
            ;;
        "monitor")
            check_aws_cli
            info "Starting continuous monitoring (Ctrl+C to stop)..."
            while true; do
                monitor_health
                sleep 300  # 5 minutes
            done
            ;;
        "create-replica")
            check_aws_cli
            local source_db="${2:-}"
            local replica_id="${3:-}"
            local target_region="${4:-}"
            local instance_class="${5:-db.r6g.large}"
            
            if [[ -z "$source_db" || -z "$replica_id" || -z "$target_region" ]]; then
                error "Usage: $0 create-replica SOURCE_DB REPLICA_ID TARGET_REGION [INSTANCE_CLASS]"
                exit 1
            fi
            
            create_replica "$source_db" "$replica_id" "$target_region" "$instance_class"
            ;;
        "delete-replica")
            check_aws_cli
            local replica_id="${2:-}"
            local region="${3:-}"
            local skip_snapshot="${4:-false}"
            
            if [[ -z "$replica_id" || -z "$region" ]]; then
                error "Usage: $0 delete-replica REPLICA_ID REGION [SKIP_FINAL_SNAPSHOT]"
                exit 1
            fi
            
            delete_replica "$replica_id" "$region" "$skip_snapshot"
            ;;
        "promote-replica")
            check_aws_cli
            local replica_id="${2:-}"
            local region="${3:-}"
            local backup_retention="${4:-30}"
            
            if [[ -z "$replica_id" || -z "$region" ]]; then
                error "Usage: $0 promote-replica REPLICA_ID REGION [BACKUP_RETENTION]"
                exit 1
            fi
            
            promote_replica "$replica_id" "$region" "$backup_retention"
            ;;
        "failover")
            local target_replica="${2:-}"
            local target_region="${3:-}"
            
            if [[ -z "$target_replica" || -z "$target_region" ]]; then
                error "Usage: $0 failover TARGET_REPLICA TARGET_REGION"
                exit 1
            fi
            
            failover_to_replica "$target_replica" "$target_region"
            ;;
        "status")
            check_aws_cli
            generate_status_report
            ;;
        "setup-monitoring")
            check_aws_cli
            setup_monitoring
            ;;
        "")
            usage
            ;;
        *)
            error "Unknown command: $command"
            usage
            exit 1
            ;;
    esac
}

# Execute main function with all arguments
main "$@"