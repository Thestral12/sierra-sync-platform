# Terraform configuration for CloudFlare WAF rules
# Sierra Sync Platform - Web Application Firewall

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }
}

variable "cloudflare_zone_id" {
  description = "CloudFlare Zone ID for sierrasync.com"
  type        = string
}

variable "cloudflare_api_token" {
  description = "CloudFlare API Token"
  type        = string
  sensitive   = true
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Rate Limiting Rules
resource "cloudflare_rate_limit" "api_rate_limit" {
  zone_id   = var.cloudflare_zone_id
  threshold = 1000
  period    = 60
  
  match {
    request {
      url_pattern = "api.sierrasync.com/api/*"
      schemes     = ["HTTPS"]
      methods     = ["GET", "POST", "PUT", "DELETE"]
    }
  }
  
  action {
    mode    = "challenge"
    timeout = 60
    
    response {
      content_type = "application/json"
      body         = jsonencode({
        error   = "Rate limit exceeded"
        message = "Too many requests. Please try again later."
        retry_after = 60
      })
    }
  }
  
  disabled           = false
  description        = "API Rate Limiting - 1000 req/min"
  bypass_url_patterns = ["*/health", "*/status"]
}

resource "cloudflare_rate_limit" "auth_rate_limit" {
  zone_id   = var.cloudflare_zone_id
  threshold = 5
  period    = 60
  
  match {
    request {
      url_pattern = "api.sierrasync.com/api/auth/login"
      schemes     = ["HTTPS"]
      methods     = ["POST"]
    }
  }
  
  action {
    mode    = "ban"
    timeout = 300  # 5 minutes
    
    response {
      content_type = "application/json"
      body         = jsonencode({
        error   = "Too many login attempts"
        message = "Account temporarily locked. Try again in 5 minutes."
        lockout_duration = 300
      })
    }
  }
  
  disabled    = false
  description = "Authentication Rate Limiting - 5 attempts/min"
}

resource "cloudflare_rate_limit" "registration_rate_limit" {
  zone_id   = var.cloudflare_zone_id
  threshold = 3
  period    = 60
  
  match {
    request {
      url_pattern = "api.sierrasync.com/api/auth/register"
      schemes     = ["HTTPS"]
      methods     = ["POST"]
    }
  }
  
  action {
    mode    = "challenge"
    timeout = 300
  }
  
  disabled    = false
  description = "Registration Rate Limiting - 3 attempts/min"
}

# Custom WAF Rules
resource "cloudflare_ruleset" "waf_custom_rules" {
  zone_id     = var.cloudflare_zone_id
  name        = "Sierra Sync Custom WAF Rules"
  description = "Custom security rules for Sierra Sync platform"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules {
    action = "block"
    action_parameters {
      response {
        status_code   = 403
        content       = jsonencode({
          error   = "Access denied"
          message = "Request blocked by security policy"
          code    = "WAF_BLOCKED"
        })
        content_type = "application/json"
      }
    }
    
    expression = <<EOF
(http.request.uri.path contains "/admin") and 
(not ip.src in {10.0.0.0/8 192.168.0.0/16 172.16.0.0/12})
EOF
    
    description = "Block admin panel access from external IPs"
    enabled     = true
  }

  rules {
    action = "challenge"
    
    expression = <<EOF
(http.request.uri.path matches "^/api/(?!auth|health)") and 
(not http.request.headers["x-api-key"][0] matches "^sk_[a-zA-Z0-9]{32}$")
EOF
    
    description = "Challenge requests without valid API key"
    enabled     = true
  }

  rules {
    action = "block"
    action_parameters {
      response {
        status_code   = 403
        content       = "Blocked: Suspicious user agent"
        content_type  = "text/plain"
      }
    }
    
    expression = <<EOF
(http.user_agent contains "sqlmap") or 
(http.user_agent contains "nmap") or 
(http.user_agent contains "nikto") or
(http.user_agent contains "gobuster") or
(http.user_agent contains "dirb")
EOF
    
    description = "Block malicious scanners and tools"
    enabled     = true
  }

  rules {
    action = "block"
    
    expression = <<EOF
(http.request.method eq "POST") and 
(http.request.uri.path contains "/upload" or http.request.uri.path contains "/import") and
(not http.request.headers["content-type"][0] matches "^multipart/form-data")
EOF
    
    description = "Protect upload endpoints from invalid content types"
    enabled     = true
  }
}

# Geographic Access Rules
resource "cloudflare_access_rule" "country_allow_list" {
  zone_id = var.cloudflare_zone_id
  mode    = "whitelist"
  
  configuration {
    target = "country"
    value  = "US"
  }
  
  notes = "Allow United States traffic"
}

resource "cloudflare_access_rule" "country_block_china" {
  zone_id = var.cloudflare_zone_id
  mode    = "block"
  
  configuration {
    target = "country" 
    value  = "CN"
  }
  
  notes = "Block China due to compliance requirements"
}

resource "cloudflare_access_rule" "country_block_russia" {
  zone_id = var.cloudflare_zone_id
  mode    = "block"
  
  configuration {
    target = "country"
    value  = "RU" 
  }
  
  notes = "Block Russia due to sanctions"
}

# Bot Management Rules
resource "cloudflare_bot_management" "sierra_sync_bot_config" {
  zone_id                       = var.cloudflare_zone_id
  enable_js                     = true
  fight_mode                    = false
  using_latest_model           = true
  suppress_session_score       = false
  auto_update_model            = true
  
  # Allow verified bots
  optimize_wordpress           = false
}

# Page Rules for Security Headers
resource "cloudflare_page_rule" "security_headers" {
  zone_id  = var.cloudflare_zone_id
  target   = "sierrasync.com/*"
  priority = 1

  actions {
    security_level = "high"
    ssl            = "flexible"
    
    # Security Headers
    browser_check = "on"
    
    # Performance
    cache_level       = "aggressive"
    edge_cache_ttl    = 7200
    browser_cache_ttl = 3600
  }
}

# DDoS Protection Settings  
resource "cloudflare_zone_settings_override" "sierra_sync_security" {
  zone_id = var.cloudflare_zone_id
  
  settings {
    # Security
    security_level         = "high"
    challenge_ttl          = 1800
    browser_check          = "on"
    hotlink_protection     = "on"
    ip_geolocation         = "on"
    server_side_exclude    = "on"
    
    # DDoS
    browser_cache_ttl      = 14400
    always_online          = "on"
    opportunistic_encryption = "on"
    
    # Bot Management
    bot_management {
      enable_js              = true
      fight_mode            = false  
      using_latest_model    = true
      suppress_session_score = false
    }
    
    # Security Headers
    security_header {
      enabled               = true
      preload              = true
      max_age              = 31536000
      include_subdomains   = true
      nosniff              = true
    }
  }
}

# Transform Rules for Security Headers
resource "cloudflare_ruleset" "security_headers" {
  zone_id     = var.cloudflare_zone_id
  name        = "Sierra Sync Security Headers"
  description = "Add security headers to all responses"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules {
    action = "rewrite"
    action_parameters {
      headers {
        "Strict-Transport-Security"   = "max-age=31536000; includeSubDomains"
        "X-Frame-Options"             = "DENY"
        "X-Content-Type-Options"      = "nosniff"
        "X-XSS-Protection"           = "1; mode=block"
        "Referrer-Policy"            = "strict-origin-when-cross-origin"
        "Permissions-Policy"         = "geolocation=(), microphone=(), camera=()"
        "Content-Security-Policy"    = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.sierrasync.com wss://api.sierrasync.com; frame-ancestors 'none';"
      }
    }
    
    expression = "(http.response.code ge 200)"
    description = "Add security headers to all successful responses"
    enabled     = true
  }
}

# WAF Managed Rules
resource "cloudflare_ruleset" "waf_managed_rules" {
  zone_id     = var.cloudflare_zone_id
  name        = "Sierra Sync WAF Managed Rules"
  description = "Managed WAF rules for common vulnerabilities"
  kind        = "zone" 
  phase       = "http_request_firewall_managed"

  rules {
    action = "execute"
    action_parameters {
      id = "efb7b8c949ac4650a09736fc376e9f27"  # CloudFlare OWASP Core Ruleset
    }
    expression = "true"
    enabled    = true
  }

  rules {
    action = "execute"
    action_parameters {
      id = "4814384a9e5d4991b9815dcfc25d2f1f"  # CloudFlare Managed Ruleset
    }
    expression = "true"
    enabled    = true
  }
}

# Output important information
output "waf_configuration_status" {
  value = {
    rate_limits_configured = true
    custom_rules_enabled   = true
    bot_management_active  = true
    security_headers_set   = true
    managed_rules_active   = true
    geographic_rules_set   = true
  }
}

output "security_endpoints" {
  value = {
    waf_dashboard = "https://dash.cloudflare.com/${var.cloudflare_zone_id}/security/waf"
    analytics     = "https://dash.cloudflare.com/${var.cloudflare_zone_id}/analytics/security"
    bot_analytics = "https://dash.cloudflare.com/${var.cloudflare_zone_id}/analytics/bots"
  }
}