#!/bin/bash

# DataDog Deployment Script for Sierra Sync
# Deploys and configures DataDog agents for APM, logging, and monitoring

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="${NAMESPACE:-sierra-sync}"
DD_NAMESPACE="${DD_NAMESPACE:-datadog}"
HELM_RELEASE_NAME="${HELM_RELEASE_NAME:-datadog}"
DD_VALUES_FILE="$SCRIPT_DIR/../config/apm/datadog-values.yaml"

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
    info "Checking prerequisites..."
    
    # Check kubectl
    if ! command -v kubectl &> /dev/null; then
        error "kubectl not found. Please install kubectl."
        exit 1
    fi
    
    # Check helm
    if ! command -v helm &> /dev/null; then
        error "Helm not found. Please install Helm."
        exit 1
    fi
    
    # Check for DataDog API key
    if [[ -z "${DD_API_KEY:-}" ]]; then
        error "DD_API_KEY environment variable not set"
        echo "Please set: export DD_API_KEY=your-datadog-api-key"
        exit 1
    fi
    
    # Check for DataDog APP key
    if [[ -z "${DD_APP_KEY:-}" ]]; then
        error "DD_APP_KEY environment variable not set"
        echo "Please set: export DD_APP_KEY=your-datadog-app-key"
        exit 1
    fi
    
    # Check namespace exists
    if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
        error "Namespace $NAMESPACE not found"
        exit 1
    fi
    
    success "Prerequisites checked"
}

# Create DataDog namespace
create_namespace() {
    info "Creating DataDog namespace..."
    
    kubectl create namespace "$DD_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    
    # Label namespace for monitoring
    kubectl label namespace "$DD_NAMESPACE" \
        monitoring=datadog \
        --overwrite
    
    success "DataDog namespace created"
}

# Create DataDog secrets
create_secrets() {
    info "Creating DataDog secrets..."
    
    # Create secret with API and APP keys
    kubectl create secret generic datadog-secret \
        --namespace="$DD_NAMESPACE" \
        --from-literal=api-key="$DD_API_KEY" \
        --from-literal=app-key="$DD_APP_KEY" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    success "DataDog secrets created"
}

# Add DataDog Helm repository
add_helm_repo() {
    info "Adding DataDog Helm repository..."
    
    helm repo add datadog https://helm.datadoghq.com
    helm repo update
    
    success "DataDog Helm repository added"
}

# Deploy DataDog agents
deploy_datadog() {
    info "Deploying DataDog agents..."
    
    # Substitute environment variables in values file
    local temp_values="/tmp/datadog-values-$(date +%s).yaml"
    envsubst < "$DD_VALUES_FILE" > "$temp_values"
    
    # Install or upgrade DataDog
    helm upgrade --install "$HELM_RELEASE_NAME" datadog/datadog \
        --namespace "$DD_NAMESPACE" \
        --values "$temp_values" \
        --set datadog.apiKey="$DD_API_KEY" \
        --set datadog.appKey="$DD_APP_KEY" \
        --set datadog.clusterName="sierra-sync-production" \
        --wait \
        --timeout 10m
    
    # Clean up temp file
    rm -f "$temp_values"
    
    success "DataDog agents deployed"
}

# Configure application for APM
configure_application() {
    info "Configuring application for APM..."
    
    # Create ConfigMap for APM configuration
    kubectl create configmap datadog-apm-config \
        --namespace="$NAMESPACE" \
        --from-literal=DD_AGENT_HOST="datadog-agent.${DD_NAMESPACE}.svc.cluster.local" \
        --from-literal=DD_TRACE_AGENT_PORT="8126" \
        --from-literal=DD_DOGSTATSD_PORT="8125" \
        --from-literal=DD_ENV="production" \
        --from-literal=DD_SERVICE="sierra-sync-api" \
        --from-literal=DD_VERSION="$(git describe --tags --always)" \
        --from-literal=DD_LOGS_INJECTION="true" \
        --from-literal=DD_RUNTIME_METRICS_ENABLED="true" \
        --from-literal=DD_PROFILING_ENABLED="true" \
        --from-literal=DD_APPSEC_ENABLED="true" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Patch application deployments to include APM environment variables
    info "Patching application deployments..."
    
    # Patch API deployment
    kubectl patch deployment sierra-sync-api \
        --namespace="$NAMESPACE" \
        --type='json' \
        -p='[
            {
                "op": "add",
                "path": "/spec/template/spec/containers/0/envFrom/-",
                "value": {
                    "configMapRef": {
                        "name": "datadog-apm-config"
                    }
                }
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1env",
                "value": "production"
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1service",
                "value": "sierra-sync-api"
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1version",
                "value": "1.0.0"
            }
        ]' || warn "Failed to patch API deployment"
    
    # Patch Web deployment
    kubectl patch deployment sierra-sync-web \
        --namespace="$NAMESPACE" \
        --type='json' \
        -p='[
            {
                "op": "add",
                "path": "/spec/template/spec/containers/0/envFrom/-",
                "value": {
                    "configMapRef": {
                        "name": "datadog-apm-config"
                    }
                }
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1env",
                "value": "production"
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1service",
                "value": "sierra-sync-web"
            },
            {
                "op": "add",
                "path": "/spec/template/metadata/labels/tags.datadoghq.com~1version",
                "value": "1.0.0"
            }
        ]' || warn "Failed to patch Web deployment"
    
    success "Application configured for APM"
}

# Create DataDog monitors
create_monitors() {
    info "Creating DataDog monitors..."
    
    # This would typically use the DataDog API to create monitors
    # For now, we'll create a ConfigMap with monitor definitions
    
    kubectl create configmap datadog-monitors \
        --namespace="$DD_NAMESPACE" \
        --from-file="$SCRIPT_DIR/../config/apm/monitors/" \
        --dry-run=client -o yaml | kubectl apply -f - 2>/dev/null || true
    
    info "Monitor definitions created (manual import required)"
}

# Verify deployment
verify_deployment() {
    info "Verifying DataDog deployment..."
    
    # Check DaemonSet status
    echo -e "\n${BLUE}=== DataDog Agent DaemonSet ===${NC}"
    kubectl get daemonset -n "$DD_NAMESPACE" -l app=datadog
    
    # Check Cluster Agent deployment
    echo -e "\n${BLUE}=== DataDog Cluster Agent ===${NC}"
    kubectl get deployment -n "$DD_NAMESPACE" -l app=datadog-cluster-agent
    
    # Check pods
    echo -e "\n${BLUE}=== DataDog Pods ===${NC}"
    kubectl get pods -n "$DD_NAMESPACE"
    
    # Wait for agents to be ready
    info "Waiting for DataDog agents to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=datadog \
        --namespace="$DD_NAMESPACE" \
        --timeout=300s || warn "Some agents may not be ready"
    
    success "DataDog deployment verified"
}

# Check agent status
check_agent_status() {
    info "Checking DataDog agent status..."
    
    # Get a DataDog agent pod
    local agent_pod=$(kubectl get pod -n "$DD_NAMESPACE" -l app=datadog -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [[ -n "$agent_pod" ]]; then
        echo -e "\n${BLUE}=== Agent Status ===${NC}"
        kubectl exec "$agent_pod" -n "$DD_NAMESPACE" -- agent status || true
        
        echo -e "\n${BLUE}=== Agent Config ===${NC}"
        kubectl exec "$agent_pod" -n "$DD_NAMESPACE" -- agent config || true
        
        echo -e "\n${BLUE}=== Agent Health ===${NC}"
        kubectl exec "$agent_pod" -n "$DD_NAMESPACE" -- agent health || true
    else
        warn "No DataDog agent pod found"
    fi
}

# Test APM connection
test_apm_connection() {
    info "Testing APM connection..."
    
    # Create a test pod that sends a trace
    kubectl run datadog-apm-test \
        --namespace="$NAMESPACE" \
        --image=node:18-alpine \
        --rm -i --tty \
        --env="DD_AGENT_HOST=datadog-agent.${DD_NAMESPACE}.svc.cluster.local" \
        --env="DD_TRACE_AGENT_PORT=8126" \
        --restart=Never \
        --command -- sh -c "
            npm install dd-trace
            node -e \"
                const tracer = require('dd-trace').init({
                    hostname: process.env.DD_AGENT_HOST,
                    port: process.env.DD_TRACE_AGENT_PORT
                });
                const span = tracer.startSpan('test.trace');
                span.setTag('test', true);
                console.log('Sending test trace...');
                span.finish();
                setTimeout(() => process.exit(0), 2000);
            \"
        " 2>/dev/null || warn "Test trace may have failed"
    
    info "Test trace sent. Check DataDog APM UI for 'test.trace' span"
}

# Uninstall DataDog
uninstall_datadog() {
    warn "This will uninstall DataDog agents!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Uninstall cancelled"
        return 0
    fi
    
    info "Uninstalling DataDog..."
    
    # Uninstall Helm release
    helm uninstall "$HELM_RELEASE_NAME" \
        --namespace "$DD_NAMESPACE" || true
    
    # Delete namespace
    kubectl delete namespace "$DD_NAMESPACE" --ignore-not-found=true
    
    # Delete application ConfigMap
    kubectl delete configmap datadog-apm-config \
        --namespace="$NAMESPACE" --ignore-not-found=true
    
    success "DataDog uninstalled"
}

# Show usage
usage() {
    cat << EOF
DataDog Deployment Script for Sierra Sync

Usage: $0 [COMMAND]

Commands:
  deploy              - Deploy DataDog agents and configure APM
  verify              - Verify DataDog deployment
  status              - Check agent status
  test                - Test APM connection
  monitors            - Create DataDog monitors
  uninstall           - Remove DataDog deployment

Examples:
  $0 deploy           - Full deployment
  $0 verify           - Verify deployment
  $0 status           - Check agent status
  $0 test             - Test APM connection

Required Environment Variables:
  DD_API_KEY          - DataDog API key
  DD_APP_KEY          - DataDog Application key

Optional Environment Variables:
  NAMESPACE           - Application namespace (default: sierra-sync)
  DD_NAMESPACE        - DataDog namespace (default: datadog)
  HELM_RELEASE_NAME   - Helm release name (default: datadog)

EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "deploy")
            check_prerequisites
            create_namespace
            create_secrets
            add_helm_repo
            deploy_datadog
            configure_application
            create_monitors
            verify_deployment
            info "DataDog deployment complete!"
            echo "Visit https://app.datadoghq.com to view metrics and traces"
            ;;
        "verify")
            check_prerequisites
            verify_deployment
            ;;
        "status")
            check_prerequisites
            check_agent_status
            ;;
        "test")
            check_prerequisites
            test_apm_connection
            ;;
        "monitors")
            check_prerequisites
            create_monitors
            ;;
        "uninstall")
            check_prerequisites
            uninstall_datadog
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