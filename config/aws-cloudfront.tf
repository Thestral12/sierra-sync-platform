# AWS CloudFront CDN Configuration for Sierra Sync Platform
# Alternative/complement to CloudFlare for global content delivery

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "domain_name" {
  description = "Domain name for the CDN"
  type        = string
  default     = "sierrasync.com"
}

variable "environment" {
  description = "Environment name"
  type        = string
  default     = "production"
}

variable "certificate_arn" {
  description = "ACM certificate ARN for SSL"
  type        = string
}

# S3 bucket for static assets (already created in cloudflare-cdn.tf)
data "aws_s3_bucket" "static_assets" {
  bucket = "sierra-sync-static-${var.environment}"
}

# Origin Access Control for CloudFront
resource "aws_cloudfront_origin_access_control" "static_assets" {
  name                              = "sierra-sync-${var.environment}-oac"
  description                       = "Origin Access Control for Sierra Sync static assets"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront Distribution
resource "aws_cloudfront_distribution" "main" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "Sierra Sync CDN - ${var.environment}"
  default_root_object = "index.html"
  price_class         = "PriceClass_All"
  http_version        = "http2and3"

  aliases = [
    var.domain_name,
    "www.${var.domain_name}",
    "static.${var.domain_name}",
    "cdn.${var.domain_name}"
  ]

  # S3 Origin for static assets
  origin {
    domain_name              = data.aws_s3_bucket.static_assets.bucket_regional_domain_name
    origin_id                = "S3-${data.aws_s3_bucket.static_assets.bucket}"
    origin_access_control_id = aws_cloudfront_origin_access_control.static_assets.id
    
    custom_header {
      name  = "X-Environment"
      value = var.environment
    }
  }

  # API Origin
  origin {
    domain_name = "api.${var.domain_name}"
    origin_id   = "API-${var.domain_name}"
    
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    
    custom_header {
      name  = "X-Forwarded-Host"
      value = var.domain_name
    }
  }

  # Web Application Origin
  origin {
    domain_name = "app.${var.domain_name}"
    origin_id   = "WEB-${var.domain_name}"
    
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default cache behavior for web application
  default_cache_behavior {
    target_origin_id       = "WEB-${var.domain_name}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    
    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = true
      headers      = ["Accept", "Accept-Language", "Authorization", "CloudFront-Forwarded-Proto", "Host", "User-Agent"]
      
      cookies {
        forward = "all"
      }
    }
    
    min_ttl     = 0
    default_ttl = 86400   # 1 day
    max_ttl     = 31536000 # 1 year
    
    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.security_headers.arn
    }
    
    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.response_headers.arn
    }
  }

  # Cache behavior for API endpoints
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "API-${var.domain_name}"
    viewer_protocol_policy = "https-only"
    compress               = true
    
    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD", "OPTIONS"]
    
    forwarded_values {
      query_string = true
      headers      = ["*"]
      
      cookies {
        forward = "all"
      }
    }
    
    min_ttl     = 0
    default_ttl = 0     # Don't cache API responses by default
    max_ttl     = 0
  }

  # Cache behavior for static assets
  ordered_cache_behavior {
    path_pattern           = "/static/*"
    target_origin_id       = "S3-${data.aws_s3_bucket.static_assets.bucket}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = false
      headers      = ["Accept-Encoding", "Accept", "Origin"]
      
      cookies {
        forward = "none"
      }
    }
    
    min_ttl     = 0
    default_ttl = 2592000  # 30 days
    max_ttl     = 31536000 # 1 year
    
    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.static_headers.arn
    }
  }

  # Cache behavior for images
  ordered_cache_behavior {
    path_pattern           = "*.{jpg,jpeg,png,gif,ico,svg,webp,avif}"
    target_origin_id       = "S3-${data.aws_s3_bucket.static_assets.bucket}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = false  # Images are already compressed
    
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = false
      headers      = ["Accept-Encoding", "Accept"]
      
      cookies {
        forward = "none"
      }
    }
    
    min_ttl     = 604800   # 1 week
    default_ttl = 7776000  # 90 days
    max_ttl     = 31536000 # 1 year
  }

  # Cache behavior for fonts
  ordered_cache_behavior {
    path_pattern           = "*.{woff,woff2,ttf,eot,otf}"
    target_origin_id       = "S3-${data.aws_s3_bucket.static_assets.bucket}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = false
    
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = false
      headers      = ["Origin", "Access-Control-Request-Headers", "Access-Control-Request-Method"]
      
      cookies {
        forward = "none"
      }
    }
    
    min_ttl     = 2592000  # 30 days
    default_ttl = 31536000 # 1 year
    max_ttl     = 31536000 # 1 year
  }

  # Cache behavior for CSS/JS
  ordered_cache_behavior {
    path_pattern           = "*.{css,js,mjs}"
    target_origin_id       = "S3-${data.aws_s3_bucket.static_assets.bucket}"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true
    
    allowed_methods = ["GET", "HEAD"]
    cached_methods  = ["GET", "HEAD"]
    
    forwarded_values {
      query_string = true  # For versioning
      headers      = ["Accept-Encoding"]
      
      cookies {
        forward = "none"
      }
    }
    
    min_ttl     = 86400    # 1 day
    default_ttl = 604800   # 1 week
    max_ttl     = 2592000  # 30 days
  }

  # Geographic restrictions
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # SSL Certificate
  viewer_certificate {
    acm_certificate_arn            = var.certificate_arn
    ssl_support_method             = "sni-only"
    minimum_protocol_version       = "TLSv1.2_2021"
    cloudfront_default_certificate = false
  }

  # Custom error pages
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/404.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/403.html"
    error_caching_min_ttl = 300
  }

  custom_error_response {
    error_code            = 500
    response_code         = 200
    response_page_path    = "/500.html"
    error_caching_min_ttl = 60
  }

  # Logging
  logging_config {
    include_cookies = false
    bucket         = aws_s3_bucket.logs.bucket_domain_name
    prefix         = "cloudfront-logs/"
  }

  # WAF Association
  web_acl_id = aws_wafv2_web_acl.cloudfront.arn

  tags = {
    Name        = "sierra-sync-${var.environment}-cdn"
    Environment = var.environment
    Component   = "cdn"
    Service     = "sierra-sync"
  }
}

# CloudFront Functions
resource "aws_cloudfront_function" "security_headers" {
  name    = "sierra-sync-security-headers"
  runtime = "cloudfront-js-1.0"
  comment = "Add security headers to requests"
  publish = true
  code    = file("${path.module}/functions/security-headers.js")
}

resource "aws_cloudfront_function" "response_headers" {
  name    = "sierra-sync-response-headers"
  runtime = "cloudfront-js-1.0"
  comment = "Add response headers"
  publish = true
  code    = file("${path.module}/functions/response-headers.js")
}

resource "aws_cloudfront_function" "static_headers" {
  name    = "sierra-sync-static-headers"
  runtime = "cloudfront-js-1.0"
  comment = "Add headers for static assets"
  publish = true
  code    = file("${path.module}/functions/static-headers.js")
}

# S3 bucket for CloudFront logs
resource "aws_s3_bucket" "logs" {
  bucket = "sierra-sync-cloudfront-logs-${var.environment}"

  tags = {
    Name        = "Sierra Sync CloudFront Logs"
    Environment = var.environment
    Component   = "logging"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "log_retention"
    status = "Enabled"

    expiration {
      days = 90
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# WAF for CloudFront
resource "aws_wafv2_web_acl" "cloudfront" {
  name  = "sierra-sync-cloudfront-waf"
  scope = "CLOUDFRONT"

  default_action {
    allow {}
  }

  # Rate limiting rule
  rule {
    name     = "RateLimitRule"
    priority = 1

    override_action {
      none {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"

        scope_down_statement {
          geo_match_statement {
            country_codes = ["US", "CA", "GB", "AU", "DE", "FR", "NL", "SE", "NO", "DK"]
          }
        }
      }
    }

    action {
      block {}
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitRule"
    }
  }

  # AWS Managed Rules
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSetMetric"
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 3

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "KnownBadInputsRuleSetMetric"
    }
  }

  tags = {
    Name        = "sierra-sync-cloudfront-waf"
    Environment = var.environment
    Component   = "security"
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "SierraSyncWAF"
  }
}

# CloudWatch Alarms
resource "aws_cloudwatch_metric_alarm" "high_4xx_error_rate" {
  alarm_name          = "sierra-sync-cloudfront-high-4xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "4xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "5"
  alarm_description   = "This metric monitors CloudFront 4xx error rate"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
  }
}

resource "aws_cloudwatch_metric_alarm" "high_5xx_error_rate" {
  alarm_name          = "sierra-sync-cloudfront-high-5xx-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "5xxErrorRate"
  namespace           = "AWS/CloudFront"
  period              = "300"
  statistic           = "Average"
  threshold           = "1"
  alarm_description   = "This metric monitors CloudFront 5xx error rate"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
  }
}

# SNS Topic for alerts
resource "aws_sns_topic" "alerts" {
  name = "sierra-sync-cloudfront-alerts"

  tags = {
    Environment = var.environment
    Component   = "monitoring"
  }
}

# Lambda function for cache invalidation
resource "aws_lambda_function" "cache_invalidator" {
  filename         = "cache-invalidator.zip"
  function_name    = "sierra-sync-cache-invalidator"
  role            = aws_iam_role.lambda_role.arn
  handler         = "index.handler"
  source_code_hash = data.archive_file.cache_invalidator.output_base64sha256
  runtime         = "nodejs18.x"
  timeout         = 60

  environment {
    variables = {
      DISTRIBUTION_ID = aws_cloudfront_distribution.main.id
    }
  }

  tags = {
    Environment = var.environment
    Component   = "automation"
  }
}

data "archive_file" "cache_invalidator" {
  type        = "zip"
  output_path = "cache-invalidator.zip"
  
  source {
    content = file("${path.module}/lambda/cache-invalidator.js")
    filename = "index.js"
  }
}

resource "aws_iam_role" "lambda_role" {
  name = "sierra-sync-cache-invalidator-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda_policy" {
  name = "sierra-sync-cache-invalidator-policy"
  role = aws_iam_role.lambda_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect = "Allow"
        Action = [
          "cloudfront:CreateInvalidation",
          "cloudfront:GetInvalidation",
          "cloudfront:ListInvalidations"
        ]
        Resource = "*"
      }
    ]
  })
}

# Outputs
output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "cloudfront_distribution_arn" {
  value = aws_cloudfront_distribution.main.arn
}

output "cache_invalidator_function_name" {
  value = aws_lambda_function.cache_invalidator.function_name
}