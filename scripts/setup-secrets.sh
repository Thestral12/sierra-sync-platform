#!/bin/bash

# Sierra Sync Platform - Secrets Setup Script
# This script initializes secrets in AWS Secrets Manager or HashiCorp Vault

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG_FILE="$PROJECT_ROOT/config/secrets-init.yaml"

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
Usage: $0 [OPTIONS]

Setup secrets management for Sierra Sync platform.

OPTIONS:
    -e, --environment ENVIRONMENT    Environment to setup (development|staging|production)
    -p, --provider PROVIDER          Secret provider (aws|vault|auto)
    -f, --force                      Force overwrite existing secrets
    -d, --dry-run                    Show what would be done without making changes
    -v, --verbose                    Enable verbose output
    -h, --help                       Show this help message

EXAMPLES:
    $0 -e development -p vault
    $0 -e production -p aws --force
    $0 -e staging --dry-run

ENVIRONMENT VARIABLES:
    AWS_REGION                       AWS region for Secrets Manager
    AWS_ACCESS_KEY_ID               AWS access key
    AWS_SECRET_ACCESS_KEY           AWS secret key
    VAULT_ADDR                      Vault server address
    VAULT_TOKEN                     Vault authentication token
    VAULT_NAMESPACE                 Vault namespace (optional)

EOF
}

# Default values
ENVIRONMENT=""
PROVIDER="auto"
FORCE=false
DRY_RUN=false
VERBOSE=false

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -e|--environment)
            ENVIRONMENT="$2"
            shift 2
            ;;
        -p|--provider)
            PROVIDER="$2"
            shift 2
            ;;
        -f|--force)
            FORCE=true
            shift
            ;;
        -d|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -v|--verbose)
            VERBOSE=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            exit 1
            ;;
    esac
done

# Validate required parameters
if [[ -z "$ENVIRONMENT" ]]; then
    log_error "Environment is required. Use -e or --environment option."
    usage
    exit 1
fi

if [[ ! "$ENVIRONMENT" =~ ^(development|staging|production)$ ]]; then
    log_error "Invalid environment: $ENVIRONMENT. Must be development, staging, or production."
    exit 1
fi

if [[ ! "$PROVIDER" =~ ^(aws|vault|auto)$ ]]; then
    log_error "Invalid provider: $PROVIDER. Must be aws, vault, or auto."
    exit 1
fi

log_info "Setting up secrets for environment: $ENVIRONMENT using provider: $PROVIDER"

# Check if required tools are installed
check_dependencies() {
    log_info "Checking dependencies..."
    
    local missing_deps=()
    
    if [[ "$PROVIDER" == "aws" ]] || [[ "$PROVIDER" == "auto" ]]; then
        if ! command -v aws >/dev/null 2>&1; then
            missing_deps+=("aws-cli")
        fi
    fi
    
    if [[ "$PROVIDER" == "vault" ]] || [[ "$PROVIDER" == "auto" ]]; then
        if ! command -v vault >/dev/null 2>&1; then
            missing_deps+=("vault")
        fi
    fi
    
    if ! command -v node >/dev/null 2>&1; then
        missing_deps+=("nodejs")
    fi
    
    if ! command -v yq >/dev/null 2>&1; then
        missing_deps+=("yq")
    fi
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        log_error "Missing required dependencies: ${missing_deps[*]}"
        log_error "Please install the missing tools and try again."
        exit 1
    fi
    
    log_success "All dependencies are installed"
}

# Validate configuration
validate_config() {
    log_info "Validating configuration..."
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        log_error "Configuration file not found: $CONFIG_FILE"
        exit 1
    fi
    
    # Check if environment exists in config
    if ! yq eval ".environments.${ENVIRONMENT}" "$CONFIG_FILE" > /dev/null 2>&1; then
        log_error "Environment '$ENVIRONMENT' not found in configuration file"
        exit 1
    fi
    
    log_success "Configuration is valid"
}

# Check AWS credentials and access
check_aws_access() {
    log_info "Checking AWS access..."
    
    if ! aws sts get-caller-identity >/dev/null 2>&1; then
        log_error "AWS credentials not configured or invalid"
        log_error "Please configure AWS credentials using 'aws configure' or environment variables"
        exit 1
    fi
    
    # Test Secrets Manager access
    if ! aws secretsmanager list-secrets --max-items 1 >/dev/null 2>&1; then
        log_error "Cannot access AWS Secrets Manager. Check permissions."
        exit 1
    fi
    
    local caller_identity=$(aws sts get-caller-identity --output text --query 'Arn')
    log_success "AWS access verified for: $caller_identity"
}

# Check Vault access
check_vault_access() {
    log_info "Checking Vault access..."
    
    if [[ -z "${VAULT_ADDR:-}" ]]; then
        log_error "VAULT_ADDR environment variable not set"
        exit 1
    fi
    
    if [[ -z "${VAULT_TOKEN:-}" ]]; then
        log_error "VAULT_TOKEN environment variable not set"
        exit 1
    fi
    
    if ! vault auth -method=token >/dev/null 2>&1; then
        log_error "Cannot authenticate with Vault. Check VAULT_TOKEN."
        exit 1
    fi
    
    log_success "Vault access verified for: $VAULT_ADDR"
}

# Generate secure random values
generate_secret() {
    local type="$1"
    local length="$2"
    local format="$3"
    local prefix="${4:-}"
    
    case "$type" in
        "password")
            if [[ "$format" == "complex" ]]; then
                # Generate complex password with special characters
                openssl rand -base64 $((length * 3 / 4)) | tr -d "=+/" | cut -c1-$length
            else
                # Generate alphanumeric password
                openssl rand -base64 $((length * 3 / 4)) | tr -d "=+/0OIl" | cut -c1-$length
            fi
            ;;
        "secret")
            case "$format" in
                "base64")
                    openssl rand -base64 $((length * 3 / 4)) | tr -d "=" | cut -c1-$length
                    ;;
                "base64url")
                    openssl rand -base64 $((length * 3 / 4)) | tr -d "=" | tr "+/" "-_" | cut -c1-$length
                    ;;
                "hex")
                    openssl rand -hex $((length / 2))
                    ;;
                *)
                    openssl rand -base64 $((length * 3 / 4)) | tr -d "=" | tr "+/" "-_" | cut -c1-$length
                    ;;
            esac
            ;;
        "client_id")
            openssl rand -hex $((length / 2))
            ;;
        "api_key")
            echo "${prefix}$(openssl rand -base64 $((length * 3 / 4)) | tr -d "=" | tr "+/" "-_" | cut -c1-$length)"
            ;;
        "rsa")
            case "$format" in
                "private")
                    openssl genpkey -algorithm RSA -pkcs8 -out /dev/stdout 2>/dev/null
                    ;;
                "public")
                    # This would need the corresponding private key
                    echo "# RSA public key generation requires private key"
                    ;;
            esac
            ;;
        *)
            openssl rand -base64 $((length * 3 / 4)) | tr -d "=" | cut -c1-$length
            ;;
    esac
}

# Process secret value with generators and placeholders
process_secret_value() {
    local value="$1"
    
    # Process generators ({{ GENERATE_* }})
    while [[ "$value" =~ \{\{[[:space:]]*GENERATE_[A-Z_]+[[:space:]]*\}\} ]]; do
        local pattern=$(echo "$value" | grep -o '{{[[:space:]]*GENERATE_[A-Z_]*[[:space:]]*}}' | head -1)
        local generator_name=$(echo "$pattern" | sed 's/{{[[:space:]]*\(GENERATE_[A-Z_]*\)[[:space:]]*}}/\1/')
        
        # Get generator definition from config
        local generator_def=$(yq eval ".generators.${generator_name}" "$CONFIG_FILE")
        
        if [[ "$generator_def" == "null" ]]; then
            log_warning "Unknown generator: $generator_name, using default"
            local generated_value=$(generate_secret "secret" 32 "base64url")
        else
            # Parse generator definition: "type:length:format:prefix"
            IFS=':' read -r gen_type gen_length gen_format gen_prefix <<< "$generator_def"
            local generated_value=$(generate_secret "$gen_type" "$gen_length" "$gen_format" "$gen_prefix")
        fi
        
        value=$(echo "$value" | sed "s|${pattern}|${generated_value}|")
    done
    
    # Process placeholders ({{ PLACEHOLDER }})
    while [[ "$value" =~ \{\{[[:space:]]*[A-Z_]+[[:space:]]*\}\} ]]; do
        local pattern=$(echo "$value" | grep -o '{{[[:space:]]*[A-Z_]*[[:space:]]*}}' | head -1)
        local placeholder_name=$(echo "$pattern" | sed 's/{{[[:space:]]*\([A-Z_]*\)[[:space:]]*}}/\1/')
        
        # Get placeholder value from environment or config
        local placeholder_value="${!placeholder_name:-}"
        if [[ -z "$placeholder_value" ]]; then
            placeholder_value=$(yq eval ".placeholders.${placeholder_name}" "$CONFIG_FILE")
        fi
        
        if [[ "$placeholder_value" == "null" ]] || [[ -z "$placeholder_value" ]]; then
            log_warning "Placeholder $placeholder_name not found, using empty string"
            placeholder_value=""
        fi
        
        value=$(echo "$value" | sed "s|${pattern}|${placeholder_value}|")
    done
    
    echo "$value"
}

# Store secret in AWS Secrets Manager
store_aws_secret() {
    local name="$1"
    local value="$2"
    local description="$3"
    local tags="$4"
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would store AWS secret: $name"
        return 0
    fi
    
    local aws_args=()
    
    # Check if secret exists
    if aws secretsmanager describe-secret --secret-id "$name" >/dev/null 2>&1; then
        if [[ "$FORCE" == true ]]; then
            log_info "Updating existing AWS secret: $name"
            aws_args+=("update-secret" "--secret-id" "$name")
        else
            log_warning "Secret '$name' already exists. Use --force to overwrite."
            return 0
        fi
    else
        log_info "Creating new AWS secret: $name"
        aws_args+=("create-secret" "--name" "$name")
    fi
    
    aws_args+=("--secret-string" "$value")
    
    if [[ -n "$description" ]]; then
        aws_args+=("--description" "$description")
    fi
    
    if [[ -n "$tags" ]] && [[ "$tags" != "null" ]]; then
        # Convert YAML tags to AWS CLI format
        local tag_args=$(echo "$tags" | yq eval 'to_entries | map("Key=" + .key + ",Value=" + .value) | join(" ")' -)
        if [[ -n "$tag_args" ]]; then
            aws_args+=("--tags" "$tag_args")
        fi
    fi
    
    if aws secretsmanager "${aws_args[@]}" >/dev/null 2>&1; then
        log_success "Successfully stored AWS secret: $name"
    else
        log_error "Failed to store AWS secret: $name"
        return 1
    fi
}

# Store secret in Vault
store_vault_secret() {
    local name="$1"
    local value="$2"
    local description="$3"
    local metadata="$4"
    
    if [[ "$DRY_RUN" == true ]]; then
        log_info "[DRY RUN] Would store Vault secret: $name"
        return 0
    fi
    
    # Get engine path from config
    local engine_path=$(yq eval ".environments.${ENVIRONMENT}.vault.engine_path" "$CONFIG_FILE")
    if [[ "$engine_path" == "null" ]]; then
        engine_path="secret"
    fi
    
    local vault_path="${engine_path}/data/${name}"
    
    # Create JSON payload
    local json_payload
    json_payload=$(cat << EOF
{
  "data": {
    "value": $value,
    "metadata": {
      "description": "$description"
    }
  }
}
EOF
)
    
    log_info "Storing Vault secret: $name"
    
    if vault kv put "$vault_path" value="$value" description="$description" >/dev/null 2>&1; then
        log_success "Successfully stored Vault secret: $name"
    else
        log_error "Failed to store Vault secret: $name"
        return 1
    fi
}

# Setup secrets for environment
setup_secrets() {
    log_info "Setting up secrets for $ENVIRONMENT environment..."
    
    # Get secrets list from config
    local secrets_count=$(yq eval ".environments.${ENVIRONMENT}.secrets | length" "$CONFIG_FILE")
    
    log_info "Found $secrets_count secrets to process"
    
    for ((i=0; i<secrets_count; i++)); do
        local secret_name=$(yq eval ".environments.${ENVIRONMENT}.secrets[${i}].name" "$CONFIG_FILE")
        local secret_value=$(yq eval ".environments.${ENVIRONMENT}.secrets[${i}].value" "$CONFIG_FILE")
        local secret_description=$(yq eval ".environments.${ENVIRONMENT}.secrets[${i}].metadata.description" "$CONFIG_FILE")
        local secret_tags=$(yq eval ".environments.${ENVIRONMENT}.secrets[${i}].metadata.tags" "$CONFIG_FILE")
        
        log_info "Processing secret: $secret_name"
        
        # Process the secret value (handle generators and placeholders)
        local processed_value
        if [[ "$secret_value" == "null" ]]; then
            log_warning "Secret value is null for: $secret_name"
            continue
        fi
        
        # Convert YAML to JSON for complex values
        if yq eval ".environments.${ENVIRONMENT}.secrets[${i}].value | type" "$CONFIG_FILE" | grep -q "!!map"; then
            processed_value=$(yq eval -o=json ".environments.${ENVIRONMENT}.secrets[${i}].value" "$CONFIG_FILE")
            processed_value=$(process_secret_value "$processed_value")
        else
            processed_value=$(process_secret_value "$secret_value")
        fi
        
        # Determine provider
        local current_provider="$PROVIDER"
        if [[ "$current_provider" == "auto" ]]; then
            current_provider=$(yq eval ".environments.${ENVIRONMENT}.provider" "$CONFIG_FILE")
        fi
        
        # Store the secret
        case "$current_provider" in
            "aws")
                store_aws_secret "$secret_name" "$processed_value" "$secret_description" "$secret_tags"
                ;;
            "vault")
                store_vault_secret "$secret_name" "$processed_value" "$secret_description" "$secret_tags"
                ;;
            *)
                log_error "Unknown provider: $current_provider"
                return 1
                ;;
        esac
        
        if [[ "$VERBOSE" == true ]]; then
            log_info "Secret $secret_name processed with provider: $current_provider"
        fi
    done
    
    log_success "All secrets processed for $ENVIRONMENT environment"
}

# Verify secrets were stored correctly
verify_secrets() {
    log_info "Verifying stored secrets..."
    
    local secrets_count=$(yq eval ".environments.${ENVIRONMENT}.secrets | length" "$CONFIG_FILE")
    local verified=0
    local failed=0
    
    for ((i=0; i<secrets_count; i++)); do
        local secret_name=$(yq eval ".environments.${ENVIRONMENT}.secrets[${i}].name" "$CONFIG_FILE")
        
        # Determine provider
        local current_provider="$PROVIDER"
        if [[ "$current_provider" == "auto" ]]; then
            current_provider=$(yq eval ".environments.${ENVIRONMENT}.provider" "$CONFIG_FILE")
        fi
        
        case "$current_provider" in
            "aws")
                if aws secretsmanager describe-secret --secret-id "$secret_name" >/dev/null 2>&1; then
                    ((verified++))
                    if [[ "$VERBOSE" == true ]]; then
                        log_success "Verified AWS secret: $secret_name"
                    fi
                else
                    ((failed++))
                    log_error "Failed to verify AWS secret: $secret_name"
                fi
                ;;
            "vault")
                local engine_path=$(yq eval ".environments.${ENVIRONMENT}.vault.engine_path" "$CONFIG_FILE")
                if [[ "$engine_path" == "null" ]]; then
                    engine_path="secret"
                fi
                
                if vault kv get "${engine_path}/data/${secret_name}" >/dev/null 2>&1; then
                    ((verified++))
                    if [[ "$VERBOSE" == true ]]; then
                        log_success "Verified Vault secret: $secret_name"
                    fi
                else
                    ((failed++))
                    log_error "Failed to verify Vault secret: $secret_name"
                fi
                ;;
        esac
    done
    
    log_info "Verification complete: $verified verified, $failed failed"
    
    if [[ $failed -gt 0 ]]; then
        return 1
    fi
    
    return 0
}

# Main execution
main() {
    log_info "Starting Sierra Sync secrets setup..."
    
    # Run checks
    check_dependencies
    validate_config
    
    # Check provider access
    case "$PROVIDER" in
        "aws")
            check_aws_access
            ;;
        "vault")
            check_vault_access
            ;;
        "auto")
            local configured_provider=$(yq eval ".environments.${ENVIRONMENT}.provider" "$CONFIG_FILE")
            case "$configured_provider" in
                "aws")
                    check_aws_access
                    ;;
                "vault")
                    check_vault_access
                    ;;
                *)
                    log_error "Unknown provider in config: $configured_provider"
                    exit 1
                    ;;
            esac
            ;;
    esac
    
    # Setup secrets
    if setup_secrets; then
        log_success "Secrets setup completed successfully"
        
        # Verify if not dry run
        if [[ "$DRY_RUN" == false ]]; then
            if verify_secrets; then
                log_success "All secrets verified successfully"
            else
                log_warning "Some secrets failed verification"
                exit 1
            fi
        fi
    else
        log_error "Secrets setup failed"
        exit 1
    fi
    
    log_success "Sierra Sync secrets setup complete!"
}

# Run main function
main "$@"