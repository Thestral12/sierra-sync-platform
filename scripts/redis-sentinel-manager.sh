#!/bin/bash

# Redis Sentinel Manager for Sierra Sync
# Manages Redis Sentinel cluster for high availability caching

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${NAMESPACE:-sierra-sync}"
REDIS_MASTER="redis-master-0.redis-master.${NAMESPACE}.svc.cluster.local"
REDIS_PORT="6379"
SENTINEL_PORT="26379"
MASTER_NAME="sierra-sync-master"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
info() {
    echo -e "${BLUE}[INFO]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $*"
}

# Check prerequisites
check_prerequisites() {
    if ! command -v kubectl &> /dev/null; then
        error "kubectl not found. Please install kubectl."
        exit 1
    fi
    
    if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
        error "Namespace $NAMESPACE not found"
        exit 1
    fi
    
    success "Prerequisites checked"
}

# Deploy Redis Sentinel cluster
deploy_sentinel() {
    info "Deploying Redis Sentinel cluster..."
    
    # Create secrets
    info "Creating Redis secrets..."
    kubectl create secret generic redis-secrets \
        --namespace="$NAMESPACE" \
        --from-literal=password="$(openssl rand -base64 32)" \
        --from-literal=config-password="$(openssl rand -base64 16)" \
        --from-literal=shutdown-password="$(openssl rand -base64 16)" \
        --from-literal=sentinel-password="$(openssl rand -base64 32)" \
        --from-literal=slack-webhook="${SLACK_WEBHOOK_URL:-}" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Create config maps
    info "Creating Redis configuration..."
    kubectl create configmap redis-config \
        --namespace="$NAMESPACE" \
        --from-file="$SCRIPT_DIR/../config/redis-sentinel/" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Apply deployment
    info "Applying Redis Sentinel deployment..."
    kubectl apply -f "$SCRIPT_DIR/../k8s/redis-sentinel-deployment.yaml"
    
    # Wait for master to be ready
    info "Waiting for Redis master to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=redis,role=master \
        --namespace="$NAMESPACE" \
        --timeout=300s
    
    # Wait for replicas to be ready
    info "Waiting for Redis replicas to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=redis,role=replica \
        --namespace="$NAMESPACE" \
        --timeout=300s
    
    # Wait for sentinels to be ready
    info "Waiting for Redis Sentinels to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=redis-sentinel \
        --namespace="$NAMESPACE" \
        --timeout=300s
    
    success "Redis Sentinel cluster deployed successfully"
}

# Check cluster status
check_status() {
    info "Checking Redis Sentinel cluster status..."
    
    # Check master status
    echo -e "\n${BLUE}=== Redis Master ===${NC}"
    kubectl get pods -l app=redis,role=master -n "$NAMESPACE" -o wide
    
    # Check replica status
    echo -e "\n${BLUE}=== Redis Replicas ===${NC}"
    kubectl get pods -l app=redis,role=replica -n "$NAMESPACE" -o wide
    
    # Check sentinel status
    echo -e "\n${BLUE}=== Redis Sentinels ===${NC}"
    kubectl get pods -l app=redis-sentinel -n "$NAMESPACE" -o wide
    
    # Get master info from sentinel
    echo -e "\n${BLUE}=== Sentinel Master Info ===${NC}"
    local sentinel_pod=$(kubectl get pod -l app=redis-sentinel -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    
    if [[ -n "$sentinel_pod" ]]; then
        kubectl exec "$sentinel_pod" -n "$NAMESPACE" -- redis-cli -p 26379 sentinel masters 2>/dev/null || \
            warn "Could not get master info from sentinel"
    fi
}

# Test Redis connection
test_connection() {
    info "Testing Redis connection..."
    
    local redis_password=$(kubectl get secret redis-secrets -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
    local master_pod=$(kubectl get pod -l app=redis,role=master -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    
    if [[ -z "$master_pod" ]]; then
        error "No Redis master pod found"
        return 1
    fi
    
    # Test SET operation
    info "Testing SET operation..."
    kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" SET test:key "test-value" EX 60
    
    # Test GET operation
    info "Testing GET operation..."
    local value=$(kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" GET test:key)
    
    if [[ "$value" == "test-value" ]]; then
        success "Redis connection test passed"
    else
        error "Redis connection test failed"
        return 1
    fi
    
    # Test replication
    info "Testing replication..."
    local replica_pod=$(kubectl get pod -l app=redis,role=replica -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    
    if [[ -n "$replica_pod" ]]; then
        sleep 2  # Wait for replication
        local replica_value=$(kubectl exec "$replica_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" GET test:key)
        
        if [[ "$replica_value" == "test-value" ]]; then
            success "Replication test passed"
        else
            warn "Replication test failed or delayed"
        fi
    fi
}

# Trigger failover
trigger_failover() {
    info "Triggering Redis Sentinel failover..."
    
    local sentinel_pod=$(kubectl get pod -l app=redis-sentinel -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    local sentinel_password=$(kubectl get secret redis-secrets -n "$NAMESPACE" -o jsonpath='{.data.sentinel-password}' | base64 -d)
    
    if [[ -z "$sentinel_pod" ]]; then
        error "No Sentinel pod found"
        return 1
    fi
    
    # Trigger failover
    kubectl exec "$sentinel_pod" -n "$NAMESPACE" -- redis-cli -p 26379 -a "$sentinel_password" \
        SENTINEL failover "$MASTER_NAME"
    
    info "Failover triggered, waiting for completion..."
    sleep 10
    
    # Check new master
    local new_master=$(kubectl exec "$sentinel_pod" -n "$NAMESPACE" -- redis-cli -p 26379 -a "$sentinel_password" \
        SENTINEL get-master-addr-by-name "$MASTER_NAME" 2>/dev/null | head -1)
    
    success "Failover completed. New master: $new_master"
}

# Monitor cluster
monitor_cluster() {
    info "Starting Redis cluster monitoring..."
    
    while true; do
        clear
        echo -e "${BLUE}=== Redis Sentinel Cluster Monitor ===${NC}"
        echo -e "Time: $(date)"
        echo
        
        # Pod status
        echo -e "${BLUE}Pod Status:${NC}"
        kubectl get pods -l 'app in (redis, redis-sentinel)' -n "$NAMESPACE" --no-headers | \
            awk '{printf "%-40s %-10s %-10s\n", $1, $2, $3}'
        echo
        
        # Get metrics from master
        local master_pod=$(kubectl get pod -l app=redis,role=master -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
        if [[ -n "$master_pod" ]]; then
            local redis_password=$(kubectl get secret redis-secrets -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
            
            echo -e "${BLUE}Redis Info:${NC}"
            kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" INFO replication 2>/dev/null | \
                grep -E "role:|connected_slaves:|slave[0-9]+:" | head -5
            echo
            
            kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" INFO stats 2>/dev/null | \
                grep -E "instantaneous_ops_per_sec:|total_connections_received:|total_commands_processed:" | head -3
        fi
        
        sleep 5
    done
}

# Scale replicas
scale_replicas() {
    local replicas="${1:-2}"
    
    info "Scaling Redis replicas to $replicas..."
    
    kubectl scale statefulset redis-replica \
        --namespace="$NAMESPACE" \
        --replicas="$replicas"
    
    info "Waiting for scaling to complete..."
    kubectl rollout status statefulset/redis-replica \
        --namespace="$NAMESPACE" \
        --timeout=300s
    
    success "Redis replicas scaled to $replicas"
}

# Backup Redis data
backup_redis() {
    local backup_dir="${1:-/tmp/redis-backup-$(date +%Y%m%d-%H%M%S)}"
    
    info "Backing up Redis data to $backup_dir..."
    
    local master_pod=$(kubectl get pod -l app=redis,role=master -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    local redis_password=$(kubectl get secret redis-secrets -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
    
    if [[ -z "$master_pod" ]]; then
        error "No Redis master pod found"
        return 1
    fi
    
    # Create backup directory
    mkdir -p "$backup_dir"
    
    # Trigger BGSAVE
    info "Triggering background save..."
    kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" BGSAVE
    
    # Wait for save to complete
    info "Waiting for save to complete..."
    while true; do
        local lastsave=$(kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" LASTSAVE)
        sleep 2
        local newsave=$(kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli -a "$redis_password" LASTSAVE)
        
        if [[ "$newsave" != "$lastsave" ]]; then
            break
        fi
    done
    
    # Copy dump file
    info "Copying dump file..."
    kubectl cp "$NAMESPACE/$master_pod:/data/redis/dump.rdb" "$backup_dir/dump.rdb"
    
    # Copy AOF file if exists
    kubectl cp "$NAMESPACE/$master_pod:/data/redis/appendonly.aof" "$backup_dir/appendonly.aof" 2>/dev/null || true
    
    # Save configuration
    kubectl get configmap redis-config -n "$NAMESPACE" -o yaml > "$backup_dir/redis-config.yaml"
    
    success "Redis backup completed: $backup_dir"
}

# Restore Redis data
restore_redis() {
    local backup_dir="${1:-}"
    
    if [[ -z "$backup_dir" || ! -d "$backup_dir" ]]; then
        error "Backup directory not found: $backup_dir"
        return 1
    fi
    
    warn "This will restore Redis data from backup. All current data will be lost!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Restore cancelled"
        return 0
    fi
    
    info "Restoring Redis data from $backup_dir..."
    
    local master_pod=$(kubectl get pod -l app=redis,role=master -n "$NAMESPACE" -o jsonpath='{.items[0].metadata.name}')
    
    if [[ -z "$master_pod" ]]; then
        error "No Redis master pod found"
        return 1
    fi
    
    # Stop Redis
    info "Stopping Redis..."
    kubectl exec "$master_pod" -n "$NAMESPACE" -- redis-cli SHUTDOWN NOSAVE
    
    # Copy backup files
    info "Copying backup files..."
    kubectl cp "$backup_dir/dump.rdb" "$NAMESPACE/$master_pod:/data/redis/dump.rdb"
    
    if [[ -f "$backup_dir/appendonly.aof" ]]; then
        kubectl cp "$backup_dir/appendonly.aof" "$NAMESPACE/$master_pod:/data/redis/appendonly.aof"
    fi
    
    # Restart Redis pod
    info "Restarting Redis..."
    kubectl delete pod "$master_pod" -n "$NAMESPACE"
    
    # Wait for pod to be ready
    kubectl wait --for=condition=ready pod \
        -l app=redis,role=master \
        --namespace="$NAMESPACE" \
        --timeout=300s
    
    success "Redis data restored from backup"
}

# Clean up resources
cleanup() {
    warn "This will delete all Redis Sentinel resources!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Cleanup cancelled"
        return 0
    fi
    
    info "Cleaning up Redis Sentinel cluster..."
    
    kubectl delete -f "$SCRIPT_DIR/../k8s/redis-sentinel-deployment.yaml" --ignore-not-found=true
    kubectl delete configmap redis-config -n "$NAMESPACE" --ignore-not-found=true
    kubectl delete secret redis-secrets -n "$NAMESPACE" --ignore-not-found=true
    kubectl delete pvc -l app=redis -n "$NAMESPACE" --ignore-not-found=true
    kubectl delete pvc -l app=redis-sentinel -n "$NAMESPACE" --ignore-not-found=true
    
    success "Redis Sentinel cluster cleaned up"
}

# Show usage
usage() {
    cat << EOF
Redis Sentinel Manager for Sierra Sync

Usage: $0 [COMMAND] [OPTIONS]

Commands:
  deploy              - Deploy Redis Sentinel cluster
  status              - Check cluster status
  test                - Test Redis connection and replication
  failover            - Trigger manual failover
  monitor             - Monitor cluster in real-time
  scale REPLICAS      - Scale Redis replicas
  backup [DIR]        - Backup Redis data
  restore DIR         - Restore Redis data from backup
  cleanup             - Remove all Redis resources

Examples:
  $0 deploy           - Deploy Redis Sentinel cluster
  $0 status           - Check current status
  $0 test             - Test Redis operations
  $0 failover         - Trigger failover
  $0 scale 3          - Scale to 3 replicas
  $0 backup           - Create backup
  $0 monitor          - Start monitoring

Environment Variables:
  NAMESPACE           - Kubernetes namespace (default: sierra-sync)
  SLACK_WEBHOOK_URL   - Slack webhook for notifications

EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "deploy")
            check_prerequisites
            deploy_sentinel
            ;;
        "status")
            check_prerequisites
            check_status
            ;;
        "test")
            check_prerequisites
            test_connection
            ;;
        "failover")
            check_prerequisites
            trigger_failover
            ;;
        "monitor")
            check_prerequisites
            monitor_cluster
            ;;
        "scale")
            check_prerequisites
            scale_replicas "${2:-2}"
            ;;
        "backup")
            check_prerequisites
            backup_redis "${2:-}"
            ;;
        "restore")
            check_prerequisites
            restore_redis "${2:-}"
            ;;
        "cleanup")
            check_prerequisites
            cleanup
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

# Execute main function
main "$@"