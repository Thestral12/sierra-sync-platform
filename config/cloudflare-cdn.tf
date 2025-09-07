# CloudFlare CDN Configuration for Sierra Sync Platform
# Terraform configuration for global content delivery network

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "cloudflare_api_token" {
  description = "CloudFlare API Token"
  type        = string
  sensitive   = true
}

variable "cloudflare_zone_id" {
  description = "CloudFlare Zone ID for sierrasync.com"
  type        = string
}

variable "aws_region" {
  description = "AWS region for S3 bucket"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

provider "aws" {
  region = var.aws_region
}

# S3 bucket for static assets
resource "aws_s3_bucket" "static_assets" {
  bucket = "sierra-sync-static-${var.environment}"

  tags = {
    Name        = "Sierra Sync Static Assets"
    Environment = var.environment
    Component   = "cdn"
  }
}

resource "aws_s3_bucket_public_access_block" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id
  depends_on = [aws_s3_bucket_public_access_block.static_assets]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "PublicReadGetObject"
        Effect    = "Allow"
        Principal = "*"
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.static_assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:Referer" = [
              "https://sierrasync.com",
              "https://www.sierrasync.com",
              "https://app.sierrasync.com"
            ]
          }
        }
      },
      {
        Sid    = "CloudFlareOriginAccess"
        Effect = "Allow"
        Principal = {
          Service = "cloudfront.amazonaws.com"
        }
        Action   = "s3:GetObject"
        Resource = "${aws_s3_bucket.static_assets.arn}/*"
      }
    ]
  })
}

resource "aws_s3_bucket_versioning" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "static_assets" {
  bucket = aws_s3_bucket.static_assets.id

  rule {
    id     = "static_assets_lifecycle"
    status = "Enabled"

    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# CloudFlare Zone Settings
resource "cloudflare_zone_settings_override" "sierra_sync" {
  zone_id = var.cloudflare_zone_id

  settings {
    # Performance settings
    always_online            = "on"
    brotli                  = "on"
    browser_cache_ttl       = 14400  # 4 hours
    browser_check           = "on"
    cache_level             = "aggressive"
    development_mode        = "off"
    early_hints            = "on"
    email_obfuscation      = "on"
    hotlink_protection     = "on"
    ip_geolocation         = "on"
    ipv6                   = "on"
    min_tls_version        = "1.2"
    mirage                 = "on"
    mobile_redirect {
      status           = "off"
      mobile_subdomain = ""
      strip_uri        = false
    }
    opportunistic_encryption = "on"
    opportunistic_onion     = "on"
    polish                  = "lossless"
    prefetch_preload        = "on"
    privacy_pass           = "on"
    response_buffering     = "on"
    rocket_loader          = "on"
    security_level         = "medium"
    server_side_exclude    = "on"
    sort_query_string_for_cache = "off"
    ssl                    = "flexible"
    tls_1_3               = "zrt"
    universal_ssl          = "on"
    webp                   = "on"
    zero_rtt               = "on"
    
    # Security settings
    always_use_https       = "on"
    automatic_https_rewrites = "on"
    security_header {
      enabled               = true
      preload              = true
      max_age              = 31536000
      include_subdomains   = true
      nosniff              = true
    }
  }
}

# Page Rules for caching optimization
resource "cloudflare_page_rule" "static_assets_cache" {
  zone_id  = var.cloudflare_zone_id
  target   = "sierrasync.com/static/*"
  priority = 1

  actions {
    cache_level                = "cache_everything"
    edge_cache_ttl            = 2592000  # 30 days
    browser_cache_ttl         = 2592000  # 30 days
    bypass_cache_on_cookie    = "wordpress_*|wp-*|comment_*|woocommerce_*"
    cache_key_fields {
      query_string {
        include = ["v", "version"]
      }
      header {
        include = ["Accept-Encoding"]
      }
      user {
        device_type = false
        geo         = false
      }
    }
  }
}

resource "cloudflare_page_rule" "api_no_cache" {
  zone_id  = var.cloudflare_zone_id
  target   = "api.sierrasync.com/*"
  priority = 2

  actions {
    cache_level = "bypass"
    ssl         = "full"
  }
}

resource "cloudflare_page_rule" "images_cache" {
  zone_id  = var.cloudflare_zone_id
  target   = "*.sierrasync.com/*.{jpg,jpeg,png,gif,ico,svg,webp}"
  priority = 3

  actions {
    cache_level                = "cache_everything"
    edge_cache_ttl            = 7776000   # 90 days
    browser_cache_ttl         = 7776000   # 90 days
    cache_deception_armor     = "on"
    origin_error_page_pass_thru = "off"
  }
}

resource "cloudflare_page_rule" "fonts_cache" {
  zone_id  = var.cloudflare_zone_id
  target   = "*.sierrasync.com/*.{woff,woff2,ttf,eot,otf}"
  priority = 4

  actions {
    cache_level       = "cache_everything"
    edge_cache_ttl    = 31536000  # 1 year
    browser_cache_ttl = 31536000  # 1 year
  }
}

resource "cloudflare_page_rule" "css_js_cache" {
  zone_id  = var.cloudflare_zone_id
  target   = "*.sierrasync.com/*.{css,js}"
  priority = 5

  actions {
    cache_level       = "cache_everything"
    edge_cache_ttl    = 604800    # 1 week
    browser_cache_ttl = 604800    # 1 week
    minify {
      css  = "on"
      js   = "on"
      html = "on"
    }
  }
}

# Load Balancer for geographic distribution
resource "cloudflare_load_balancer_pool" "api_us_east" {
  name = "sierra-sync-api-us-east"

  origins {
    name    = "api-us-east-1"
    address = "api-us-east.sierrasync.com"
    enabled = true
    weight  = 1
  }

  description = "Sierra Sync API - US East"
  enabled     = true
  
  monitor = cloudflare_load_balancer_monitor.api_monitor.id
}

resource "cloudflare_load_balancer_pool" "api_us_west" {
  name = "sierra-sync-api-us-west"

  origins {
    name    = "api-us-west-1"
    address = "api-us-west.sierrasync.com"
    enabled = true
    weight  = 1
  }

  description = "Sierra Sync API - US West"
  enabled     = true
  
  monitor = cloudflare_load_balancer_monitor.api_monitor.id
}

resource "cloudflare_load_balancer_pool" "api_eu" {
  name = "sierra-sync-api-eu"

  origins {
    name    = "api-eu-1"
    address = "api-eu.sierrasync.com"
    enabled = true
    weight  = 1
  }

  description = "Sierra Sync API - Europe"
  enabled     = true
  
  monitor = cloudflare_load_balancer_monitor.api_monitor.id
}

resource "cloudflare_load_balancer_monitor" "api_monitor" {
  expected_codes = "200"
  method         = "GET"
  path           = "/api/health"
  header {
    header = "Host"
    values = ["api.sierrasync.com"]
  }
  timeout       = 10
  retries       = 3
  interval      = 60
  description   = "Sierra Sync API Health Monitor"
  type          = "http"
  port          = 443
  allow_insecure = false
}

resource "cloudflare_load_balancer" "api" {
  zone_id          = var.cloudflare_zone_id
  name             = "sierra-sync-api-lb"
  fallback_pool_id = cloudflare_load_balancer_pool.api_us_east.id

  default_pool_ids = [
    cloudflare_load_balancer_pool.api_us_east.id
  ]

  description = "Sierra Sync API Global Load Balancer"
  ttl         = 30
  proxied     = true

  # Geographic routing rules
  region_pools {
    region   = "WNAM"  # Western North America
    pool_ids = [cloudflare_load_balancer_pool.api_us_west.id]
  }

  region_pools {
    region   = "ENAM"  # Eastern North America
    pool_ids = [cloudflare_load_balancer_pool.api_us_east.id]
  }

  region_pools {
    region   = "WEU"   # Western Europe
    pool_ids = [cloudflare_load_balancer_pool.api_eu.id]
  }

  region_pools {
    region   = "EEU"   # Eastern Europe
    pool_ids = [cloudflare_load_balancer_pool.api_eu.id]
  }

  # Steering policy for intelligent routing
  steering_policy = "geo"
  
  # Session affinity
  session_affinity = "cookie"
  session_affinity_ttl = 3600
  
  # Adaptive routing
  adaptive_routing {
    failover_across_pools = true
  }
}

# Transform Rules for optimization
resource "cloudflare_ruleset" "transform_rules" {
  zone_id     = var.cloudflare_zone_id
  name        = "Sierra Sync Transform Rules"
  description = "Optimization and transform rules for Sierra Sync"
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules {
    action = "rewrite"
    action_parameters {
      headers {
        "Cache-Control"           = "public, max-age=31536000, immutable"
        "X-Content-Type-Options"  = "nosniff"
        "X-Frame-Options"        = "SAMEORIGIN"
        "X-XSS-Protection"       = "1; mode=block"
        "Strict-Transport-Security" = "max-age=31536000; includeSubDomains; preload"
      }
    }
    
    expression = "(http.request.uri.path matches \".*\\.(css|js|png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot)$\")"
    description = "Add caching and security headers for static assets"
    enabled     = true
  }

  rules {
    action = "rewrite"
    action_parameters {
      headers {
        "Content-Security-Policy" = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' https://api.sierrasync.com wss://api.sierrasync.com; frame-ancestors 'self';"
        "Referrer-Policy"         = "strict-origin-when-cross-origin"
        "Permissions-Policy"      = "geolocation=(), microphone=(), camera=()"
      }
    }
    
    expression = "(http.request.uri.path eq \"/\" or http.request.uri.path matches \"^/(?!api/).*\")"
    description = "Add security headers for web pages"
    enabled     = true
  }
}

# Workers for advanced edge logic
resource "cloudflare_worker_script" "asset_optimization" {
  name    = "sierra-sync-asset-optimization"
  content = file("${path.module}/workers/asset-optimization.js")

  plain_text_binding {
    name = "ENVIRONMENT"
    text = var.environment
  }

  secret_text_binding {
    name = "S3_BUCKET"
    text = aws_s3_bucket.static_assets.bucket
  }
}

resource "cloudflare_worker_route" "asset_optimization" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "sierrasync.com/static/*"
  script_name = cloudflare_worker_script.asset_optimization.name
}

# Analytics and monitoring
resource "cloudflare_web_analytics_site" "sierra_sync" {
  account_id   = var.cloudflare_account_id
  zone_tag     = var.cloudflare_zone_id
  auto_install = true
}

resource "cloudflare_web_analytics_rule" "sierra_sync_rules" {
  account_id = var.cloudflare_account_id
  ruleset_id = cloudflare_web_analytics_site.sierra_sync.ruleset_id

  enabled    = true
  expression = "(http.host eq \"sierrasync.com\")"
  action     = "execute"
  
  action_parameters {
    id = "execute"
  }
}

# Cache Purge Webhook
resource "cloudflare_worker_script" "cache_purge_webhook" {
  name    = "sierra-sync-cache-purge"
  content = file("${path.module}/workers/cache-purge.js")

  secret_text_binding {
    name = "WEBHOOK_SECRET"
    text = var.webhook_secret
  }

  secret_text_binding {
    name = "CF_API_TOKEN"
    text = var.cloudflare_api_token
  }

  plain_text_binding {
    name = "ZONE_ID"
    text = var.cloudflare_zone_id
  }
}

resource "cloudflare_worker_route" "cache_purge" {
  zone_id     = var.cloudflare_zone_id
  pattern     = "sierrasync.com/webhook/cache-purge"
  script_name = cloudflare_worker_script.cache_purge_webhook.name
}

# DNS Records for CDN
resource "cloudflare_record" "cdn_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "cdn"
  value   = "sierrasync.com"
  type    = "CNAME"
  proxied = true
  ttl     = 1  # Automatic when proxied
}

resource "cloudflare_record" "static_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "static"
  value   = aws_s3_bucket.static_assets.bucket_regional_domain_name
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

# Rate Limiting for CDN endpoints
resource "cloudflare_rate_limit" "static_assets_rate_limit" {
  zone_id   = var.cloudflare_zone_id
  threshold = 10000
  period    = 60
  
  match {
    request {
      url_pattern = "sierrasync.com/static/*"
      schemes     = ["HTTPS"]
      methods     = ["GET"]
    }
  }
  
  action {
    mode    = "ban"
    timeout = 300
    
    response {
      content_type = "application/json"
      body         = jsonencode({
        error = "Rate limit exceeded for static assets"
        retry_after = 300
      })
    }
  }
  
  disabled    = false
  description = "Rate limiting for static assets"
}

# Output important information
output "cdn_configuration" {
  value = {
    s3_bucket_name           = aws_s3_bucket.static_assets.bucket
    s3_bucket_domain         = aws_s3_bucket.static_assets.bucket_regional_domain_name
    cloudflare_zone_id       = var.cloudflare_zone_id
    load_balancer_hostname   = cloudflare_load_balancer.api.hostname
    static_assets_url        = "https://static.sierrasync.com"
    cdn_url                 = "https://cdn.sierrasync.com"
    cache_purge_webhook     = "https://sierrasync.com/webhook/cache-purge"
  }
}

output "performance_settings" {
  value = {
    brotli_compression      = "enabled"
    image_optimization      = "enabled"
    minification           = "enabled"
    rocket_loader          = "enabled"
    early_hints           = "enabled"
    http2                 = "enabled"
    http3                 = "enabled"
    zero_rtt              = "enabled"
  }
}

output "caching_rules" {
  value = {
    static_assets_cache_ttl = "30 days"
    images_cache_ttl       = "90 days"
    fonts_cache_ttl        = "1 year"
    css_js_cache_ttl       = "1 week"
    api_cache_policy       = "bypass"
  }
}