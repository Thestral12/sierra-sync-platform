#!/bin/bash

# Istio Service Mesh Deployment Script for Sierra Sync
# Installs and configures Istio with production settings

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ISTIO_VERSION="${ISTIO_VERSION:-1.20.0}"
NAMESPACE="istio-system"
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
    }
    
    # Check cluster connection
    if ! kubectl cluster-info &>/dev/null; then
        error "Cannot connect to Kubernetes cluster"
        exit 1
    fi
    
    success "Prerequisites checked"
}

# Download and install istioctl
install_istioctl() {
    if command -v istioctl &> /dev/null; then
        local installed_version=$(istioctl version --short --remote=false 2>/dev/null || echo "unknown")
        info "istioctl already installed (version: $installed_version)"
        
        if [[ "$installed_version" != "$ISTIO_VERSION" ]]; then
            warn "Version mismatch. Installed: $installed_version, Required: $ISTIO_VERSION"
            read -p "Update istioctl? (y/n): " update
            if [[ "$update" != "y" ]]; then
                return
            fi
        else
            return
        fi
    fi
    
    info "Installing istioctl version $ISTIO_VERSION..."
    
    # Download istioctl
    curl -L https://istio.io/downloadIstio | ISTIO_VERSION=$ISTIO_VERSION sh -
    
    # Move to PATH
    sudo mv istio-$ISTIO_VERSION/bin/istioctl /usr/local/bin/
    rm -rf istio-$ISTIO_VERSION
    
    success "istioctl installed successfully"
}

# Install Istio control plane
install_istio() {
    info "Installing Istio control plane..."
    
    # Create Istio configuration
    cat > /tmp/istio-config.yaml << EOF
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
metadata:
  name: control-plane
spec:
  profile: production
  
  meshConfig:
    accessLogFile: /dev/stdout
    defaultConfig:
      holdApplicationUntilProxyStarts: true
      proxyStatsMatcher:
        inclusionRegexps:
          - ".*outlier_detection.*"
          - ".*circuit_breakers.*"
          - ".*upstream_rq_retry.*"
          - ".*upstream_rq_pending.*"
    extensionProviders:
      # Jaeger tracing
      - name: jaeger
        envoyExtAuthzGrpc:
          service: jaeger-collector.istio-system.svc.cluster.local
          port: 9411
      
      # Prometheus metrics
      - name: prometheus
        prometheus:
          service: prometheus.monitoring.svc.cluster.local
          port: 9090
      
      # DataDog integration
      - name: datadog
        envoyExtAuthzGrpc:
          service: datadog-agent.datadog.svc.cluster.local
          port: 8126
      
      # File-based access logging
      - name: file
        file:
          path: /dev/stdout
          format: |
            [%START_TIME%] "%REQ(:METHOD)% %REQ(X-ENVOY-ORIGINAL-PATH?:PATH)% %PROTOCOL%"
            %RESPONSE_CODE% %RESPONSE_FLAGS% %BYTES_RECEIVED% %BYTES_SENT%
            "%DOWNSTREAM_REMOTE_ADDRESS%" "%REQ(X-FORWARDED-FOR)%" "%REQ(USER-AGENT)%"
            "%REQ(X-REQUEST-ID)%" "%REQ(:AUTHORITY)%" "%UPSTREAM_HOST%"
            %DURATION% %RESP(X-ENVOY-UPSTREAM-SERVICE-TIME)% "%REQ(X-FORWARDED-PROTO)%"
    
    outboundTrafficPolicy:
      mode: REGISTRY_ONLY
    
  components:
    pilot:
      k8s:
        resources:
          requests:
            cpu: 1000m
            memory: 2Gi
          limits:
            cpu: 2000m
            memory: 4Gi
        hpaSpec:
          minReplicas: 2
          maxReplicas: 5
          metrics:
            - type: Resource
              resource:
                name: cpu
                target:
                  type: Utilization
                  averageUtilization: 80
        affinity:
          podAntiAffinity:
            requiredDuringSchedulingIgnoredDuringExecution:
              - labelSelector:
                  matchLabels:
                    app: istiod
                topologyKey: kubernetes.io/hostname
    
    ingressGateways:
      - name: istio-ingressgateway
        enabled: true
        k8s:
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 1Gi
          hpaSpec:
            minReplicas: 2
            maxReplicas: 10
            metrics:
              - type: Resource
                resource:
                  name: cpu
                  target:
                    type: Utilization
                    averageUtilization: 80
          service:
            type: LoadBalancer
            ports:
              - port: 15021
                targetPort: 15021
                name: status-port
              - port: 80
                targetPort: 8080
                name: http2
              - port: 443
                targetPort: 8443
                name: https
              - port: 15443
                targetPort: 15443
                name: tls
    
    egressGateways:
      - name: istio-egressgateway
        enabled: true
        k8s:
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
  
  values:
    global:
      proxy:
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 200m
            memory: 256Mi
        accessLogFile: /dev/stdout
        logLevel: warning
      
      tracer:
        zipkin:
          address: jaeger-collector.istio-system:9411
    
    pilot:
      traceSampling: 1.0
      env:
        PILOT_ENABLE_PROTOCOL_SNIFFING_FOR_OUTBOUND: true
        PILOT_ENABLE_PROTOCOL_SNIFFING_FOR_INBOUND: true
    
    telemetry:
      v2:
        prometheus:
          configOverride:
            inboundSidecar:
              disable_host_header_fallback: true
            outboundSidecar:
              disable_host_header_fallback: true
EOF
    
    # Install Istio
    istioctl install -f /tmp/istio-config.yaml --skip-confirmation
    
    # Wait for Istio to be ready
    info "Waiting for Istio components to be ready..."
    kubectl wait --for=condition=ready pod \
        -l app=istiod \
        -n istio-system \
        --timeout=300s
    
    kubectl wait --for=condition=ready pod \
        -l app=istio-ingressgateway \
        -n istio-system \
        --timeout=300s
    
    success "Istio control plane installed"
}

# Install Istio addons
install_addons() {
    info "Installing Istio addons..."
    
    # Download Istio release for addon manifests
    if [[ ! -d "istio-$ISTIO_VERSION" ]]; then
        curl -L https://istio.io/downloadIstio | ISTIO_VERSION=$ISTIO_VERSION sh -
    fi
    
    # Install Prometheus
    kubectl apply -f istio-$ISTIO_VERSION/samples/addons/prometheus.yaml || true
    
    # Install Grafana
    kubectl apply -f istio-$ISTIO_VERSION/samples/addons/grafana.yaml || true
    
    # Install Jaeger
    kubectl apply -f istio-$ISTIO_VERSION/samples/addons/jaeger.yaml || true
    
    # Install Kiali
    kubectl apply -f istio-$ISTIO_VERSION/samples/addons/kiali.yaml || true
    
    # Clean up
    rm -rf istio-$ISTIO_VERSION
    
    success "Istio addons installed"
}

# Configure Sierra Sync namespace
configure_namespace() {
    info "Configuring Sierra Sync namespace for Istio..."
    
    # Create namespace if not exists
    kubectl create namespace "$APP_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    
    # Enable Istio injection
    kubectl label namespace "$APP_NAMESPACE" istio-injection=enabled --overwrite
    
    success "Namespace configured for Istio injection"
}

# Apply Sierra Sync Istio configurations
apply_istio_config() {
    info "Applying Sierra Sync Istio configurations..."
    
    kubectl apply -f "$SCRIPT_DIR/../k8s/service-mesh/istio-setup.yaml"
    
    success "Istio configurations applied"
}

# Create TLS certificates
create_tls_certificates() {
    info "Creating TLS certificates..."
    
    # Check if certificate already exists
    if kubectl get secret sierra-sync-tls -n istio-system &>/dev/null; then
        warn "TLS certificate already exists"
        return
    fi
    
    # Generate self-signed certificate (for demo purposes)
    openssl req -x509 -newkey rsa:4096 -sha256 -days 365 -nodes \
        -keyout /tmp/tls.key -out /tmp/tls.crt \
        -subj "/CN=*.sierrasync.com" \
        -addext "subjectAltName=DNS:*.sierrasync.com,DNS:sierrasync.com"
    
    # Create secret
    kubectl create secret tls sierra-sync-tls \
        --cert=/tmp/tls.crt \
        --key=/tmp/tls.key \
        -n istio-system
    
    # Clean up
    rm /tmp/tls.key /tmp/tls.crt
    
    success "TLS certificates created"
}

# Verify Istio installation
verify_installation() {
    info "Verifying Istio installation..."
    
    # Check Istio version
    istioctl version
    
    # Analyze configuration
    istioctl analyze -n "$APP_NAMESPACE"
    
    # Check proxy status
    istioctl proxy-status
    
    # Get ingress gateway external IP
    local INGRESS_IP=$(kubectl get svc istio-ingressgateway -n istio-system \
        -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
    
    if [[ -z "$INGRESS_IP" ]]; then
        INGRESS_IP=$(kubectl get svc istio-ingressgateway -n istio-system \
            -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
    fi
    
    if [[ -n "$INGRESS_IP" ]]; then
        success "Ingress Gateway External IP: $INGRESS_IP"
    else
        warn "Ingress Gateway External IP not yet assigned"
    fi
    
    success "Istio installation verified"
}

# Setup monitoring dashboards
setup_dashboards() {
    info "Setting up monitoring dashboards..."
    
    # Port forward to access dashboards
    echo -e "\n${BLUE}=== Access Dashboards ===${NC}"
    echo "Kiali: istioctl dashboard kiali"
    echo "Grafana: istioctl dashboard grafana"
    echo "Jaeger: istioctl dashboard jaeger"
    echo "Prometheus: istioctl dashboard prometheus"
    echo
    echo "Or use port forwarding:"
    echo "kubectl port-forward -n istio-system svc/kiali 20001:20001"
    echo "kubectl port-forward -n istio-system svc/grafana 3000:3000"
    echo "kubectl port-forward -n istio-system svc/tracing 16686:80"
    echo "kubectl port-forward -n istio-system svc/prometheus 9090:9090"
}

# Enable mTLS strict mode
enable_mtls() {
    info "Enabling strict mTLS..."
    
    kubectl apply -f - <<EOF
apiVersion: security.istio.io/v1beta1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
EOF
    
    success "Strict mTLS enabled"
}

# Uninstall Istio
uninstall_istio() {
    warn "This will uninstall Istio and all related resources!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Uninstall cancelled"
        return
    fi
    
    info "Uninstalling Istio..."
    
    # Remove Istio configurations
    kubectl delete -f "$SCRIPT_DIR/../k8s/service-mesh/istio-setup.yaml" --ignore-not-found=true
    
    # Uninstall Istio
    istioctl uninstall --purge -y
    
    # Remove namespace
    kubectl delete namespace istio-system --ignore-not-found=true
    
    # Remove labels
    kubectl label namespace "$APP_NAMESPACE" istio-injection-
    
    success "Istio uninstalled"
}

# Show usage
usage() {
    cat << EOF
Istio Service Mesh Deployment Script for Sierra Sync

Usage: $0 [COMMAND]

Commands:
  install             - Install Istio with production configuration
  configure           - Configure Sierra Sync for Istio
  verify              - Verify Istio installation
  dashboards          - Show dashboard access information
  uninstall           - Remove Istio installation

Examples:
  $0 install          - Complete Istio installation
  $0 configure        - Apply Sierra Sync configurations
  $0 verify           - Check installation status

Environment Variables:
  ISTIO_VERSION       - Istio version to install (default: 1.20.0)

EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "install")
            check_prerequisites
            install_istioctl
            install_istio
            install_addons
            configure_namespace
            create_tls_certificates
            apply_istio_config
            enable_mtls
            verify_installation
            setup_dashboards
            success "Istio installation complete!"
            ;;
        "configure")
            check_prerequisites
            configure_namespace
            apply_istio_config
            success "Configuration complete!"
            ;;
        "verify")
            check_prerequisites
            verify_installation
            ;;
        "dashboards")
            setup_dashboards
            ;;
        "uninstall")
            check_prerequisites
            uninstall_istio
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