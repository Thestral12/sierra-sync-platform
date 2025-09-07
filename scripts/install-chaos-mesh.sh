#!/bin/bash

# Chaos Mesh Installation Script for Sierra Sync
# Installs and configures Chaos Mesh for resilience testing

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHAOS_MESH_VERSION="${CHAOS_MESH_VERSION:-2.6.0}"
NAMESPACE="chaos-testing"
APP_NAMESPACE="sierra-sync"

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
    
    if ! command -v kubectl &> /dev/null; then
        error "kubectl not found. Please install kubectl."
        exit 1
    fi
    
    if ! command -v helm &> /dev/null; then
        error "Helm not found. Please install Helm."
        exit 1
    fi
    
    # Check cluster connection
    if ! kubectl cluster-info &>/dev/null; then
        error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    success "Prerequisites checked"
}

# Install cert-manager (required for Chaos Mesh)
install_cert_manager() {
    info "Checking cert-manager..."
    
    if kubectl get namespace cert-manager &>/dev/null; then
        info "cert-manager already installed"
        return
    fi
    
    info "Installing cert-manager..."
    kubectl apply -f https://github.com/cert-manager/cert-manager/releases/latest/download/cert-manager.yaml
    
    # Wait for cert-manager to be ready
    kubectl wait --for=condition=ready pod \
        -l app.kubernetes.io/instance=cert-manager \
        -n cert-manager \
        --timeout=300s
    
    success "cert-manager installed"
}

# Install Chaos Mesh
install_chaos_mesh() {
    info "Installing Chaos Mesh version $CHAOS_MESH_VERSION..."
    
    # Add Chaos Mesh Helm repository
    helm repo add chaos-mesh https://charts.chaos-mesh.org
    helm repo update
    
    # Create namespace
    kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -
    
    # Install Chaos Mesh with custom values
    helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh \
        --namespace $NAMESPACE \
        --version $CHAOS_MESH_VERSION \
        --set dashboard.create=true \
        --set dashboard.securityMode=true \
        --set chaosDaemon.runtime=containerd \
        --set chaosDaemon.socketPath=/run/containerd/containerd.sock \
        --set controllerManager.replicaCount=3 \
        --set prometheus.create=true \
        --set webhook.certManager.enabled=true \
        --wait
    
    success "Chaos Mesh installed"
}

# Configure RBAC for Chaos experiments
configure_rbac() {
    info "Configuring RBAC for Chaos experiments..."
    
    kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: chaos-mesh-experiments
rules:
  - apiGroups: ["chaos-mesh.org"]
    resources: ["*"]
    verbs: ["*"]
  - apiGroups: [""]
    resources: ["pods", "namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: chaos-mesh-experiments
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: chaos-mesh-experiments
subjects:
  - kind: ServiceAccount
    name: chaos-controller-manager
    namespace: $NAMESPACE
EOF
    
    success "RBAC configured"
}

# Deploy chaos experiments
deploy_experiments() {
    info "Deploying chaos experiments..."
    
    kubectl apply -f "$SCRIPT_DIR/../k8s/chaos-engineering/chaos-mesh.yaml"
    
    success "Chaos experiments deployed"
}

# Create dashboard access token
create_dashboard_token() {
    info "Creating dashboard access token..."
    
    # Create service account for dashboard access
    kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: chaos-dashboard-viewer
  namespace: $NAMESPACE
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: chaos-dashboard-viewer
rules:
  - apiGroups: [""]
    resources: ["pods", "namespaces", "nodes"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["chaos-mesh.org"]
    resources: ["*"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: chaos-dashboard-viewer
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: chaos-dashboard-viewer
subjects:
  - kind: ServiceAccount
    name: chaos-dashboard-viewer
    namespace: $NAMESPACE
---
apiVersion: v1
kind: Secret
metadata:
  name: chaos-dashboard-viewer-token
  namespace: $NAMESPACE
  annotations:
    kubernetes.io/service-account.name: chaos-dashboard-viewer
type: kubernetes.io/service-account-token
EOF
    
    # Get token
    local TOKEN=$(kubectl get secret chaos-dashboard-viewer-token -n $NAMESPACE -o jsonpath='{.data.token}' | base64 -d)
    
    echo
    echo -e "${GREEN}=== Chaos Mesh Dashboard Access ===${NC}"
    echo "URL: http://localhost:2333"
    echo "Token: $TOKEN"
    echo
    echo "To access the dashboard, run:"
    echo "kubectl port-forward -n $NAMESPACE svc/chaos-dashboard 2333:2333"
    echo
}

# Install Litmus Chaos (alternative to Chaos Mesh)
install_litmus() {
    info "Installing Litmus Chaos..."
    
    # Create namespace
    kubectl create namespace litmus --dry-run=client -o yaml | kubectl apply -f -
    
    # Install Litmus operator
    kubectl apply -f https://litmuschaos.github.io/litmus/litmus-operator-v3.0.0.yaml
    
    # Install Litmus ChaosCenter
    kubectl apply -f https://raw.githubusercontent.com/litmuschaos/litmus/master/mkdocs/docs/3.0.0/litmus-3.0.0.yaml
    
    # Wait for Litmus to be ready
    kubectl wait --for=condition=ready pod \
        -l app.kubernetes.io/component=litmus \
        -n litmus \
        --timeout=300s
    
    success "Litmus Chaos installed"
}

# Create chaos experiments library
create_experiment_library() {
    info "Creating chaos experiment library..."
    
    cat > "$SCRIPT_DIR/../docs/chaos-experiments.md" << 'EOF'
# Chaos Engineering Experiments Library

## Network Experiments

### 1. Latency Injection
- **Target**: API services
- **Impact**: Adds 100ms latency with 50ms jitter
- **Schedule**: Every 6 hours
- **Purpose**: Test timeout handling and retry logic

### 2. Packet Loss
- **Target**: Database connections
- **Impact**: 10% packet loss
- **Schedule**: Every 4 hours
- **Purpose**: Test connection resilience

### 3. Network Partition
- **Target**: Service mesh
- **Impact**: Isolates services
- **Schedule**: On-demand
- **Purpose**: Test split-brain scenarios

## Pod Experiments

### 1. Pod Failure
- **Target**: API pods (30%)
- **Impact**: Terminates pods
- **Schedule**: Every 3 hours
- **Purpose**: Test auto-recovery and scaling

### 2. Container Kill
- **Target**: Worker containers
- **Impact**: Kills specific containers
- **Schedule**: Every 2 hours
- **Purpose**: Test container restart policies

## Resource Experiments

### 1. CPU Stress
- **Target**: API services
- **Impact**: 80% CPU utilization
- **Schedule**: Every 8 hours
- **Purpose**: Test performance under load

### 2. Memory Stress
- **Target**: Cache services
- **Impact**: 256MB memory pressure
- **Schedule**: Every 6 hours
- **Purpose**: Test memory limits and OOM handling

### 3. Disk I/O Stress
- **Target**: Database
- **Impact**: 100ms I/O delay
- **Schedule**: Every 5 hours
- **Purpose**: Test disk performance impact

## Application Experiments

### 1. HTTP Failures
- **Target**: API endpoints
- **Impact**: Returns 503 errors
- **Schedule**: Every 4 hours
- **Purpose**: Test error handling

### 2. Response Delays
- **Target**: API responses
- **Impact**: 3s delay
- **Schedule**: Every 3 hours
- **Purpose**: Test timeout behavior

## System Experiments

### 1. Clock Skew
- **Target**: API pods (30%)
- **Impact**: 30s time offset
- **Schedule**: Every 8 hours
- **Purpose**: Test time synchronization

### 2. DNS Failures
- **Target**: External services
- **Impact**: DNS resolution errors
- **Schedule**: Every 6 hours
- **Purpose**: Test DNS fallback

## Workflow Experiments

### 1. Peak Load Simulation
- **Components**: CPU stress + Network delay + Pod failures
- **Duration**: 30 minutes
- **Schedule**: Weekly
- **Purpose**: Test peak load resilience

### 2. Disaster Recovery Test
- **Components**: Database + Cache + API failures
- **Duration**: 20 minutes
- **Schedule**: Monthly
- **Purpose**: Test disaster recovery procedures

## Running Experiments

### Manual Execution
```bash
# Run specific experiment
kubectl apply -f experiments/network-latency.yaml

# Stop experiment
kubectl delete networkchaos api-latency-injection -n sierra-sync
```

### Scheduled Execution
Experiments run automatically based on cron schedules.

### Monitoring
- Chaos Mesh Dashboard: http://localhost:2333
- Grafana: http://localhost:3000
- Prometheus: http://localhost:9090

## Safety Measures

1. **Blast Radius**: Limited to specific namespaces
2. **Duration Limits**: Maximum 30 minutes per experiment
3. **Percentage Limits**: Maximum 50% of pods affected
4. **Recovery Validation**: Automatic health checks after experiments
5. **Emergency Stop**: `kubectl delete -f chaos-mesh.yaml`
EOF
    
    success "Experiment library created"
}

# Verify installation
verify_installation() {
    info "Verifying Chaos Mesh installation..."
    
    # Check pods
    kubectl get pods -n $NAMESPACE
    
    # Check CRDs
    kubectl get crd | grep chaos-mesh
    
    # Check experiments
    kubectl get networkchaos,podchaos,stresschaos -n $APP_NAMESPACE
    
    success "Installation verified"
}

# Uninstall Chaos Mesh
uninstall_chaos_mesh() {
    warn "This will uninstall Chaos Mesh and all experiments!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Uninstall cancelled"
        return
    fi
    
    info "Uninstalling Chaos Mesh..."
    
    # Delete experiments
    kubectl delete -f "$SCRIPT_DIR/../k8s/chaos-engineering/chaos-mesh.yaml" --ignore-not-found=true
    
    # Uninstall Chaos Mesh
    helm uninstall chaos-mesh -n $NAMESPACE
    
    # Delete namespace
    kubectl delete namespace $NAMESPACE --ignore-not-found=true
    
    success "Chaos Mesh uninstalled"
}

# Show usage
usage() {
    cat << EOF
Chaos Mesh Installation Script for Sierra Sync

Usage: $0 [COMMAND]

Commands:
  install             - Install Chaos Mesh and experiments
  litmus              - Install Litmus Chaos (alternative)
  verify              - Verify installation
  token               - Show dashboard access token
  uninstall           - Remove Chaos Mesh

Examples:
  $0 install          - Complete installation
  $0 verify           - Check installation status
  $0 token            - Get dashboard token

Environment Variables:
  CHAOS_MESH_VERSION  - Chaos Mesh version (default: 2.6.0)

EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "install")
            check_prerequisites
            install_cert_manager
            install_chaos_mesh
            configure_rbac
            deploy_experiments
            create_dashboard_token
            create_experiment_library
            verify_installation
            success "Chaos Mesh installation complete!"
            ;;
        "litmus")
            check_prerequisites
            install_litmus
            success "Litmus installation complete!"
            ;;
        "verify")
            check_prerequisites
            verify_installation
            ;;
        "token")
            create_dashboard_token
            ;;
        "uninstall")
            check_prerequisites
            uninstall_chaos_mesh
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