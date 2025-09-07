#!/bin/bash

# ELK Stack Deployment Script for Sierra Sync
# Deploys Elasticsearch, Logstash, Kibana, and Filebeat

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAMESPACE="logging"
ES_VERSION="8.11.1"

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
    
    if ! command -v openssl &> /dev/null; then
        error "openssl not found. Please install openssl."
        exit 1
    fi
    
    success "Prerequisites checked"
}

# Create namespace
create_namespace() {
    info "Creating logging namespace..."
    
    kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
    
    # Label namespace
    kubectl label namespace "$NAMESPACE" \
        monitoring=enabled \
        name=logging \
        --overwrite
    
    success "Namespace created"
}

# Generate certificates
generate_certificates() {
    info "Generating SSL certificates..."
    
    local cert_dir="/tmp/elk-certs-$(date +%s)"
    mkdir -p "$cert_dir"
    
    # Generate CA key and certificate
    openssl req -x509 -newkey rsa:4096 -keyout "$cert_dir/ca.key" -out "$cert_dir/ca.crt" \
        -days 365 -nodes -subj "/CN=ElasticCA"
    
    # Generate Elasticsearch certificate
    openssl req -new -newkey rsa:4096 -keyout "$cert_dir/elasticsearch.key" -out "$cert_dir/elasticsearch.csr" \
        -nodes -subj "/CN=elasticsearch"
    openssl x509 -req -in "$cert_dir/elasticsearch.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" \
        -CAcreateserial -out "$cert_dir/elasticsearch.crt" -days 365
    
    # Generate Logstash certificate
    openssl req -new -newkey rsa:4096 -keyout "$cert_dir/logstash.key" -out "$cert_dir/logstash.csr" \
        -nodes -subj "/CN=logstash"
    openssl x509 -req -in "$cert_dir/logstash.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" \
        -CAcreateserial -out "$cert_dir/logstash.crt" -days 365
    
    # Generate Kibana certificate
    openssl req -new -newkey rsa:4096 -keyout "$cert_dir/kibana.key" -out "$cert_dir/kibana.csr" \
        -nodes -subj "/CN=kibana"
    openssl x509 -req -in "$cert_dir/kibana.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" \
        -CAcreateserial -out "$cert_dir/kibana.crt" -days 365
    
    # Generate Filebeat certificate
    openssl req -new -newkey rsa:4096 -keyout "$cert_dir/filebeat.key" -out "$cert_dir/filebeat.csr" \
        -nodes -subj "/CN=filebeat"
    openssl x509 -req -in "$cert_dir/filebeat.csr" -CA "$cert_dir/ca.crt" -CAkey "$cert_dir/ca.key" \
        -CAcreateserial -out "$cert_dir/filebeat.crt" -days 365
    
    # Create PKCS12 keystore for Elasticsearch
    openssl pkcs12 -export -out "$cert_dir/elastic-certificates.p12" \
        -inkey "$cert_dir/elasticsearch.key" -in "$cert_dir/elasticsearch.crt" \
        -CAfile "$cert_dir/ca.crt" -passout pass:
    
    # Create Kubernetes secrets
    kubectl create secret generic elasticsearch-certificates \
        --namespace="$NAMESPACE" \
        --from-file="$cert_dir/elastic-certificates.p12" \
        --from-file="$cert_dir/ca.crt" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    kubectl create secret generic logstash-certificates \
        --namespace="$NAMESPACE" \
        --from-file="$cert_dir/logstash.crt" \
        --from-file="$cert_dir/logstash.key" \
        --from-file="$cert_dir/ca.crt" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    kubectl create secret generic kibana-certificates \
        --namespace="$NAMESPACE" \
        --from-file="$cert_dir/kibana.crt" \
        --from-file="$cert_dir/kibana.key" \
        --from-file="$cert_dir/ca.crt" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    kubectl create secret generic filebeat-certificates \
        --namespace="$NAMESPACE" \
        --from-file="$cert_dir/filebeat.crt" \
        --from-file="$cert_dir/filebeat.key" \
        --from-file="$cert_dir/ca.crt" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Clean up temporary files
    rm -rf "$cert_dir"
    
    success "Certificates generated and stored"
}

# Generate passwords
generate_passwords() {
    info "Generating passwords..."
    
    local elastic_password=$(openssl rand -base64 32)
    local kibana_password=$(openssl rand -base64 32)
    local kibana_encryption_key=$(openssl rand -base64 32)
    local kibana_saved_objects_key=$(openssl rand -base64 32)
    local kibana_reporting_key=$(openssl rand -base64 32)
    
    # Create Elasticsearch credentials secret
    kubectl create secret generic elasticsearch-credentials \
        --namespace="$NAMESPACE" \
        --from-literal=password="$elastic_password" \
        --from-literal=kibana-password="$kibana_password" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Create Kibana secrets
    kubectl create secret generic kibana-secrets \
        --namespace="$NAMESPACE" \
        --from-literal=encryption-key="$kibana_encryption_key" \
        --from-literal=saved-objects-key="$kibana_saved_objects_key" \
        --from-literal=reporting-key="$kibana_reporting_key" \
        --dry-run=client -o yaml | kubectl apply -f -
    
    # Save passwords for reference
    cat > /tmp/elk-passwords.txt << EOF
=== ELK Stack Passwords ===
Elastic Password: $elastic_password
Kibana System Password: $kibana_password
Kibana Encryption Key: $kibana_encryption_key

Save these passwords securely!
EOF
    
    info "Passwords saved to /tmp/elk-passwords.txt"
    success "Passwords generated"
}

# Create index templates
create_templates() {
    info "Creating Logstash templates..."
    
    cat << 'EOF' | kubectl create configmap logstash-templates \
        --namespace="$NAMESPACE" \
        --from-file=sierra-sync.json=/dev/stdin \
        --dry-run=client -o yaml | kubectl apply -f -
{
  "index_patterns": ["sierra-sync-*"],
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "index.refresh_interval": "5s",
    "index.codec": "best_compression"
  },
  "mappings": {
    "properties": {
      "@timestamp": { "type": "date" },
      "level": { "type": "keyword" },
      "message": { "type": "text" },
      "service": { "type": "keyword" },
      "environment": { "type": "keyword" },
      "trace_id": { "type": "keyword" },
      "span_id": { "type": "keyword" },
      "user_id": { "type": "keyword" },
      "organization_id": { "type": "keyword" },
      "request_id": { "type": "keyword" },
      "method": { "type": "keyword" },
      "path": { "type": "keyword" },
      "status_code": { "type": "integer" },
      "response_time_ms": { "type": "float" },
      "client_ip": { "type": "ip" },
      "user_agent": { "type": "text" },
      "error": {
        "properties": {
          "type": { "type": "keyword" },
          "message": { "type": "text" },
          "stack": { "type": "text" }
        }
      },
      "kubernetes": {
        "properties": {
          "namespace": { "type": "keyword" },
          "pod": { "type": "keyword" },
          "container": { "type": "keyword" },
          "node": { "type": "keyword" }
        }
      },
      "geoip": {
        "properties": {
          "location": { "type": "geo_point" },
          "country_name": { "type": "keyword" },
          "city_name": { "type": "keyword" }
        }
      }
    }
  }
}
EOF
    
    success "Templates created"
}

# Deploy ELK Stack
deploy_elk() {
    info "Deploying ELK Stack..."
    
    kubectl apply -f "$SCRIPT_DIR/../k8s/observability/elk-stack.yaml"
    
    success "ELK Stack deployment initiated"
}

# Wait for Elasticsearch
wait_for_elasticsearch() {
    info "Waiting for Elasticsearch to be ready..."
    
    kubectl wait --for=condition=ready pod \
        -l app=elasticsearch,role=master \
        --namespace="$NAMESPACE" \
        --timeout=600s || warn "Some Elasticsearch master nodes may not be ready"
    
    kubectl wait --for=condition=ready pod \
        -l app=elasticsearch,role=data \
        --namespace="$NAMESPACE" \
        --timeout=600s || warn "Some Elasticsearch data nodes may not be ready"
    
    success "Elasticsearch is ready"
}

# Setup Elasticsearch users
setup_users() {
    info "Setting up Elasticsearch users..."
    
    local elastic_pod=$(kubectl get pod -n "$NAMESPACE" -l app=elasticsearch,role=master -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [[ -z "$elastic_pod" ]]; then
        warn "No Elasticsearch pod found, skipping user setup"
        return
    fi
    
    # Get elastic password
    local elastic_password=$(kubectl get secret elasticsearch-credentials -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
    
    # Create kibana_system user
    kubectl exec "$elastic_pod" -n "$NAMESPACE" -- curl -k -X POST \
        "https://localhost:9200/_security/user/kibana_system/_password" \
        -H "Content-Type: application/json" \
        -u "elastic:$elastic_password" \
        -d "{\"password\":\"$(kubectl get secret elasticsearch-credentials -n $NAMESPACE -o jsonpath='{.data.kibana-password}' | base64 -d)\"}" \
        2>/dev/null || warn "Failed to set kibana_system password"
    
    # Create logstash_system user
    kubectl exec "$elastic_pod" -n "$NAMESPACE" -- curl -k -X POST \
        "https://localhost:9200/_security/user/logstash_system" \
        -H "Content-Type: application/json" \
        -u "elastic:$elastic_password" \
        -d '{
          "password": "'"$(openssl rand -base64 32)"'",
          "roles": ["logstash_system"],
          "full_name": "Logstash System User"
        }' 2>/dev/null || warn "Failed to create logstash_system user"
    
    success "Users configured"
}

# Wait for all components
wait_for_all() {
    info "Waiting for all components to be ready..."
    
    # Wait for Logstash
    kubectl wait --for=condition=ready pod \
        -l app=logstash \
        --namespace="$NAMESPACE" \
        --timeout=300s || warn "Logstash may not be ready"
    
    # Wait for Kibana
    kubectl wait --for=condition=ready pod \
        -l app=kibana \
        --namespace="$NAMESPACE" \
        --timeout=300s || warn "Kibana may not be ready"
    
    success "All components deployed"
}

# Create Kibana dashboards
create_dashboards() {
    info "Creating Kibana dashboards..."
    
    local kibana_pod=$(kubectl get pod -n "$NAMESPACE" -l app=kibana -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
    
    if [[ -z "$kibana_pod" ]]; then
        warn "No Kibana pod found, skipping dashboard creation"
        return
    fi
    
    # Wait for Kibana API to be ready
    sleep 30
    
    # Import saved objects
    kubectl exec "$kibana_pod" -n "$NAMESPACE" -- curl -k -X POST \
        "https://localhost:5601/api/saved_objects/_import" \
        -H "kbn-xsrf: true" \
        -H "Content-Type: application/json" \
        -u "elastic:$(kubectl get secret elasticsearch-credentials -n $NAMESPACE -o jsonpath='{.data.password}' | base64 -d)" \
        -d '{
          "objects": [
            {
              "id": "sierra-sync-overview",
              "type": "dashboard",
              "attributes": {
                "title": "Sierra Sync Overview Dashboard",
                "description": "Main dashboard for Sierra Sync application logs"
              }
            }
          ]
        }' 2>/dev/null || warn "Failed to create dashboards"
    
    success "Dashboards created"
}

# Port forward for access
setup_port_forward() {
    info "Setting up port forwarding..."
    
    echo -e "\n${BLUE}=== Access Information ===${NC}"
    echo "Kibana: kubectl port-forward -n $NAMESPACE svc/kibana 5601:5601"
    echo "Elasticsearch: kubectl port-forward -n $NAMESPACE svc/elasticsearch 9200:9200"
    echo
    echo "Then access:"
    echo "  Kibana: https://localhost:5601"
    echo "  Elasticsearch: https://localhost:9200"
    echo
    echo "Credentials are in /tmp/elk-passwords.txt"
}

# Verify deployment
verify_deployment() {
    info "Verifying ELK Stack deployment..."
    
    echo -e "\n${BLUE}=== Elasticsearch Pods ===${NC}"
    kubectl get pods -n "$NAMESPACE" -l app=elasticsearch
    
    echo -e "\n${BLUE}=== Logstash Pods ===${NC}"
    kubectl get pods -n "$NAMESPACE" -l app=logstash
    
    echo -e "\n${BLUE}=== Kibana Pods ===${NC}"
    kubectl get pods -n "$NAMESPACE" -l app=kibana
    
    echo -e "\n${BLUE}=== Filebeat Pods ===${NC}"
    kubectl get pods -n "$NAMESPACE" -l app=filebeat
    
    echo -e "\n${BLUE}=== Services ===${NC}"
    kubectl get svc -n "$NAMESPACE"
    
    echo -e "\n${BLUE}=== PVCs ===${NC}"
    kubectl get pvc -n "$NAMESPACE"
    
    success "Deployment verified"
}

# Cleanup function
cleanup() {
    warn "This will delete the entire ELK Stack deployment!"
    read -p "Are you sure? (yes/no): " confirm
    
    if [[ "$confirm" != "yes" ]]; then
        info "Cleanup cancelled"
        return 0
    fi
    
    info "Cleaning up ELK Stack..."
    
    kubectl delete -f "$SCRIPT_DIR/../k8s/observability/elk-stack.yaml" --ignore-not-found=true
    kubectl delete namespace "$NAMESPACE" --ignore-not-found=true
    
    success "ELK Stack cleaned up"
}

# Show usage
usage() {
    cat << EOF
ELK Stack Deployment Script for Sierra Sync

Usage: $0 [COMMAND]

Commands:
  deploy              - Deploy complete ELK Stack
  verify              - Verify deployment status
  port-forward        - Show port forwarding commands
  cleanup             - Remove ELK Stack deployment

Examples:
  $0 deploy           - Full deployment
  $0 verify           - Check deployment status
  $0 port-forward     - Get access information

Requirements:
  - kubectl configured with cluster access
  - openssl for certificate generation

EOF
}

# Main function
main() {
    local command="${1:-}"
    
    case "$command" in
        "deploy")
            check_prerequisites
            create_namespace
            generate_certificates
            generate_passwords
            create_templates
            deploy_elk
            wait_for_elasticsearch
            setup_users
            wait_for_all
            create_dashboards
            setup_port_forward
            verify_deployment
            success "ELK Stack deployment complete!"
            ;;
        "verify")
            check_prerequisites
            verify_deployment
            ;;
        "port-forward")
            setup_port_forward
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