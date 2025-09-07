#!/bin/bash

# Sierra Sync Blue-Green Deployment Scripts
# Comprehensive deployment automation for production environments

set -euo pipefail

# Configuration
NAMESPACE="sierra-sync"
APP_NAME="sierra-sync"
ROLLOUT_NAME="sierra-sync-api-rollout"
WEB_ROLLOUT_NAME="sierra-sync-web-rollout"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Usage information
usage() {
    cat << EOF
Usage: $0 [COMMAND] [OPTIONS]

Blue-Green Deployment Commands for Sierra Sync Platform

COMMANDS:
    deploy IMAGE_TAG            Deploy new version using blue-green strategy
    promote                     Promote preview to active after successful analysis
    rollback                    Rollback to previous stable version
    status                      Show current deployment status
    canary IMAGE_TAG WEIGHT     Deploy canary version with traffic weight
    abort                       Abort current deployment
    health                      Check health of current deployments
    traffic-split BLUE GREEN    Split traffic between blue/green (percentages)

OPTIONS:
    -n, --namespace NAMESPACE   Kubernetes namespace (default: sierra-sync)
    -t, --timeout TIMEOUT       Deployment timeout in minutes (default: 10)
    -w, --wait                  Wait for deployment to complete
    -v, --verbose               Enable verbose output
    -d, --dry-run               Show what would be done without executing
    -h, --help                  Show this help message

EXAMPLES:
    $0 deploy v1.2.3 --wait
    $0 canary v1.2.4 10
    $0 promote
    $0 rollback
    $0 traffic-split 80 20
    $0 status

ENVIRONMENT VARIABLES:
    KUBECONFIG                  Path to kubeconfig file
    SIERRA_SYNC_REGISTRY        Container registry URL
    SLACK_WEBHOOK_URL          Slack webhook for notifications
    DEPLOYMENT_TIMEOUT          Default deployment timeout (minutes)

EOF
}

# Default values
TIMEOUT=${DEPLOYMENT_TIMEOUT:-10}
WAIT=false
VERBOSE=false
DRY_RUN=false

# Parse command line arguments
COMMAND=""
IMAGE_TAG=""
CANARY_WEIGHT=""
BLUE_WEIGHT=""
GREEN_WEIGHT=""

while [[ $# -gt 0 ]]; do
    case $1 in
        deploy|promote|rollback|status|canary|abort|health|traffic-split)
            COMMAND="$1"
            shift
            ;;
        -n|--namespace)
            NAMESPACE="$2"
            shift 2
            ;;
        -t|--timeout)
            TIMEOUT="$2"
            shift 2
            ;;
        -w|--wait)
            WAIT=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            if [[ -z "$IMAGE_TAG" && "$COMMAND" =~ ^(deploy|canary)$ ]]; then
                IMAGE_TAG="$1"
            elif [[ -z "$CANARY_WEIGHT" && "$COMMAND" == "canary" ]]; then
                CANARY_WEIGHT="$1"
            elif [[ -z "$BLUE_WEIGHT" && "$COMMAND" == "traffic-split" ]]; then
                BLUE_WEIGHT="$1"
            elif [[ -z "$GREEN_WEIGHT" && "$COMMAND" == "traffic-split" ]]; then
                GREEN_WEIGHT="$1"
            else
                log_error "Unknown argument: $1"
                usage
                exit 1
            fi
            shift
            ;;
    esac
done

# Validate required parameters
if [[ -z "$COMMAND" ]]; then
    log_error "Command is required"
    usage
    exit 1
fi

# Check if required tools are installed
check_dependencies() {
    local missing_deps=()
    
    if ! command -v kubectl >/dev/null 2>&1; then
        missing_deps+=("kubectl")
    fi
    
    if ! command -v argo >/dev/null 2>&1; then
        missing_deps+=("argo-rollouts-cli")
    fi
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing_deps[*]}"
        exit 1
    fi
}

# Send Slack notification
send_notification() {
    local message="$1"
    local color="$2"  # good, warning, danger
    
    if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        local payload=$(cat <<EOF
{
    "attachments": [{
        "color": "$color",
        "title": "Sierra Sync Deployment",
        "text": "$message",
        "fields": [
            {
                "title": "Environment",
                "value": "$NAMESPACE",
                "short": true
            },
            {
                "title": "Timestamp",
                "value": "$(date -u +"%Y-%m-%d %H:%M:%S UTC")",
                "short": true
            }
        ]
    }]
}
EOF
        )
        
        curl -X POST -H 'Content-type: application/json' \
             --data "$payload" "$SLACK_WEBHOOK_URL" >/dev/null 2>&1 || true
    fi
}

# Get rollout status
get_rollout_status() {
    local rollout_name="$1"
    kubectl argo rollouts get rollout "$rollout_name" -n "$NAMESPACE" -o json 2>/dev/null || echo "{}"
}

# Wait for rollout completion
wait_for_rollout() {
    local rollout_name="$1"
    local timeout_minutes="$2"
    
    log_info "Waiting for rollout to complete (timeout: ${timeout_minutes}m)..."
    
    if kubectl argo rollouts wait rollout "$rollout_name" \
        -n "$NAMESPACE" \
        --timeout="${timeout_minutes}m"; then
        log_success "Rollout completed successfully"
        return 0
    else
        log_error "Rollout failed or timed out"
        return 1
    fi
}

# Check deployment health
check_health() {
    local service_name="$1"
    local max_retries=5
    local retry_count=0
    
    while [[ $retry_count -lt $max_retries ]]; do
        if kubectl exec -n "$NAMESPACE" deployment/sierra-sync-api -- \
            curl -f "http://${service_name}.${NAMESPACE}.svc.cluster.local:3001/api/health" >/dev/null 2>&1; then
            return 0
        fi
        
        ((retry_count++))
        sleep 2
    done
    
    return 1
}

# Deploy new version
deploy_version() {
    local image_tag="$1"
    
    log_info "Starting blue-green deployment of version: $image_tag"
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would deploy image: ghcr.io/sierra-sync/api:$image_tag"
        return 0
    fi
    
    # Update API rollout
    kubectl argo rollouts set image "$ROLLOUT_NAME" \
        api="ghcr.io/sierra-sync/api:$image_tag" \
        -n "$NAMESPACE"
    
    # Update Web rollout
    kubectl argo rollouts set image "$WEB_ROLLOUT_NAME" \
        web="ghcr.io/sierra-sync/web:$image_tag" \
        -n "$NAMESPACE"
    
    send_notification "🚀 Started deployment of version $image_tag" "warning"
    
    if [[ "$WAIT" == true ]]; then
        if wait_for_rollout "$ROLLOUT_NAME" "$TIMEOUT" && \
           wait_for_rollout "$WEB_ROLLOUT_NAME" "$TIMEOUT"; then
            
            # Check health of preview services
            if check_health "sierra-sync-api-preview" && \
               check_health "sierra-sync-web-preview"; then
                log_success "Deployment ready for promotion"
                send_notification "✅ Deployment $image_tag is healthy and ready for promotion" "good"
            else
                log_error "Health checks failed for preview services"
                send_notification "❌ Health checks failed for deployment $image_tag" "danger"
                return 1
            fi
        else
            log_error "Deployment failed"
            send_notification "❌ Deployment $image_tag failed" "danger"
            return 1
        fi
    fi
}

# Promote preview to active
promote_deployment() {
    log_info "Promoting preview deployment to active..."
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would promote preview to active"
        return 0
    fi
    
    # Check analysis results before promotion
    local analysis_status
    analysis_status=$(kubectl get analysisrun -l rollout="$ROLLOUT_NAME" \
        -n "$NAMESPACE" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "Unknown")
    
    if [[ "$analysis_status" != "Successful" ]] && [[ "$analysis_status" != "Unknown" ]]; then
        log_error "Cannot promote: Analysis status is $analysis_status"
        return 1
    fi
    
    # Promote API rollout
    kubectl argo rollouts promote "$ROLLOUT_NAME" -n "$NAMESPACE"
    
    # Promote Web rollout
    kubectl argo rollouts promote "$WEB_ROLLOUT_NAME" -n "$NAMESPACE"
    
    if [[ "$WAIT" == true ]]; then
        wait_for_rollout "$ROLLOUT_NAME" "$TIMEOUT"
        wait_for_rollout "$WEB_ROLLOUT_NAME" "$TIMEOUT"
    fi
    
    log_success "Deployment promoted successfully"
    send_notification "🎉 Deployment promoted to production successfully" "good"
}

# Rollback to previous version
rollback_deployment() {
    log_info "Rolling back to previous stable version..."
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would rollback to previous version"
        return 0
    fi
    
    # Abort current rollouts
    kubectl argo rollouts abort "$ROLLOUT_NAME" -n "$NAMESPACE" 2>/dev/null || true
    kubectl argo rollouts abort "$WEB_ROLLOUT_NAME" -n "$NAMESPACE" 2>/dev/null || true
    
    # Rollback to previous version
    kubectl argo rollouts undo "$ROLLOUT_NAME" -n "$NAMESPACE"
    kubectl argo rollouts undo "$WEB_ROLLOUT_NAME" -n "$NAMESPACE"
    
    if [[ "$WAIT" == true ]]; then
        wait_for_rollout "$ROLLOUT_NAME" "$TIMEOUT"
        wait_for_rollout "$WEB_ROLLOUT_NAME" "$TIMEOUT"
    fi
    
    log_success "Rollback completed"
    send_notification "🔄 Rollback completed successfully" "warning"
}

# Show deployment status
show_status() {
    log_info "Current deployment status:"
    
    echo ""
    echo "API Rollout Status:"
    kubectl argo rollouts get rollout "$ROLLOUT_NAME" -n "$NAMESPACE" || true
    
    echo ""
    echo "Web Rollout Status:"
    kubectl argo rollouts get rollout "$WEB_ROLLOUT_NAME" -n "$NAMESPACE" || true
    
    echo ""
    echo "Active Services:"
    kubectl get svc -l component=active-service -n "$NAMESPACE" -o wide || true
    
    echo ""
    echo "Preview Services:"
    kubectl get svc -l component=preview-service -n "$NAMESPACE" -o wide || true
    
    echo ""
    echo "Recent Analysis Runs:"
    kubectl get analysisrun -l rollout="$ROLLOUT_NAME" -n "$NAMESPACE" --sort-by='.metadata.creationTimestamp' | tail -5 || true
}

# Deploy canary version
deploy_canary() {
    local image_tag="$1"
    local weight="$2"
    
    log_info "Starting canary deployment: $image_tag with ${weight}% traffic"
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would deploy canary: ghcr.io/sierra-sync/api:$image_tag with ${weight}% traffic"
        return 0
    fi
    
    # Update rollout with canary strategy
    kubectl patch rollout "$ROLLOUT_NAME" -n "$NAMESPACE" --type='merge' -p="{
        \"spec\": {
            \"strategy\": {
                \"canary\": {
                    \"steps\": [
                        {\"setWeight\": $weight},
                        {\"pause\": {\"duration\": \"5m\"}},
                        {\"analysis\": {
                            \"templates\": [{\"templateName\": \"sierra-sync-canary-analysis\"}]
                        }}
                    ]
                }
            }
        }
    }"
    
    # Update image
    kubectl argo rollouts set image "$ROLLOUT_NAME" \
        api="ghcr.io/sierra-sync/api:$image_tag" \
        -n "$NAMESPACE"
    
    send_notification "🧪 Started canary deployment of $image_tag with ${weight}% traffic" "warning"
}

# Abort current deployment
abort_deployment() {
    log_info "Aborting current deployment..."
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would abort current deployment"
        return 0
    fi
    
    kubectl argo rollouts abort "$ROLLOUT_NAME" -n "$NAMESPACE"
    kubectl argo rollouts abort "$WEB_ROLLOUT_NAME" -n "$NAMESPACE"
    
    log_success "Deployment aborted"
    send_notification "⛔ Deployment aborted" "danger"
}

# Check overall health
check_deployment_health() {
    log_info "Checking deployment health..."
    
    local services=("sierra-sync-api-active" "sierra-sync-web-active")
    local healthy=true
    
    for service in "${services[@]}"; do
        echo -n "Checking $service... "
        if check_health "$service"; then
            echo -e "${GREEN}✓ Healthy${NC}"
        else
            echo -e "${RED}✗ Unhealthy${NC}"
            healthy=false
        fi
    done
    
    if [[ "$healthy" == true ]]; then
        log_success "All services are healthy"
        return 0
    else
        log_error "Some services are unhealthy"
        return 1
    fi
}

# Split traffic between blue/green
split_traffic() {
    local blue_weight="$1"
    local green_weight="$2"
    
    log_info "Splitting traffic: ${blue_weight}% blue, ${green_weight}% green"
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would split traffic: ${blue_weight}% blue, ${green_weight}% green"
        return 0
    fi
    
    # Update traffic split (this would typically be done via service mesh or ingress controller)
    kubectl patch service sierra-sync-api-active -n "$NAMESPACE" --type='merge' -p="{
        \"metadata\": {
            \"annotations\": {
                \"traffic.split.blue\": \"$blue_weight\",
                \"traffic.split.green\": \"$green_weight\"
            }
        }
    }"
    
    log_success "Traffic split updated"
    send_notification "🔀 Traffic split updated: ${blue_weight}% blue, ${green_weight}% green" "good"
}

# Main execution
main() {
    log_info "Sierra Sync Blue-Green Deployment Tool"
    
    check_dependencies
    
    case "$COMMAND" in
        deploy)
            if [[ -z "$IMAGE_TAG" ]]; then
                log_error "Image tag is required for deploy command"
                exit 1
            fi
            deploy_version "$IMAGE_TAG"
            ;;
        promote)
            promote_deployment
            ;;
        rollback)
            rollback_deployment
            ;;
        status)
            show_status
            ;;
        canary)
            if [[ -z "$IMAGE_TAG" ]] || [[ -z "$CANARY_WEIGHT" ]]; then
                log_error "Image tag and canary weight are required for canary command"
                exit 1
            fi
            deploy_canary "$IMAGE_TAG" "$CANARY_WEIGHT"
            ;;
        abort)
            abort_deployment
            ;;
        health)
            check_deployment_health
            ;;
        traffic-split)
            if [[ -z "$BLUE_WEIGHT" ]] || [[ -z "$GREEN_WEIGHT" ]]; then
                log_error "Blue and green weights are required for traffic-split command"
                exit 1
            fi
            split_traffic "$BLUE_WEIGHT" "$GREEN_WEIGHT"
            ;;
        *)
            log_error "Unknown command: $COMMAND"
            usage
            exit 1
            ;;
    esac
}

# Run main function
main "$@"