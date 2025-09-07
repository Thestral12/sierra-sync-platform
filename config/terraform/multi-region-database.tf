# Multi-Region PostgreSQL Database Configuration
# Implements read replicas across multiple AWS regions for high availability

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# Primary region (us-east-1)
provider "aws" {
  alias  = "primary"
  region = "us-east-1"
}

# Secondary region (us-west-2)
provider "aws" {
  alias  = "secondary"
  region = "us-west-2"
}

# Tertiary region (eu-west-1)
provider "aws" {
  alias  = "tertiary"
  region = "eu-west-1"
}

# Data sources for availability zones
data "aws_availability_zones" "primary" {
  provider = aws.primary
  state    = "available"
}

data "aws_availability_zones" "secondary" {
  provider = aws.secondary
  state    = "available"
}

data "aws_availability_zones" "tertiary" {
  provider = aws.tertiary
  state    = "available"
}

# Random password for database
resource "random_password" "db_password" {
  length  = 32
  special = true
}

# KMS keys for encryption in each region
resource "aws_kms_key" "primary_db_key" {
  provider    = aws.primary
  description = "KMS key for Sierra Sync primary database encryption"
  
  tags = {
    Name        = "sierra-sync-db-primary"
    Environment = "production"
    Service     = "database"
  }
}

resource "aws_kms_key" "secondary_db_key" {
  provider    = aws.secondary
  description = "KMS key for Sierra Sync secondary database encryption"
  
  tags = {
    Name        = "sierra-sync-db-secondary"
    Environment = "production"
    Service     = "database"
  }
}

resource "aws_kms_key" "tertiary_db_key" {
  provider    = aws.tertiary
  description = "KMS key for Sierra Sync tertiary database encryption"
  
  tags = {
    Name        = "sierra-sync-db-tertiary"
    Environment = "production"
    Service     = "database"
  }
}

# KMS aliases
resource "aws_kms_alias" "primary_db_key" {
  provider      = aws.primary
  name          = "alias/sierra-sync-db-primary"
  target_key_id = aws_kms_key.primary_db_key.key_id
}

resource "aws_kms_alias" "secondary_db_key" {
  provider      = aws.secondary
  name          = "alias/sierra-sync-db-secondary"
  target_key_id = aws_kms_key.secondary_db_key.key_id
}

resource "aws_kms_alias" "tertiary_db_key" {
  provider      = aws.tertiary
  name          = "alias/sierra-sync-db-tertiary"
  target_key_id = aws_kms_key.tertiary_db_key.key_id
}

# Primary DB subnet group (us-east-1)
resource "aws_db_subnet_group" "primary" {
  provider = aws.primary
  name     = "sierra-sync-primary-subnet-group"
  subnet_ids = [
    aws_subnet.primary_private_1.id,
    aws_subnet.primary_private_2.id
  ]

  tags = {
    Name        = "Sierra Sync Primary DB Subnet Group"
    Environment = "production"
  }
}

# Secondary DB subnet group (us-west-2)
resource "aws_db_subnet_group" "secondary" {
  provider = aws.secondary
  name     = "sierra-sync-secondary-subnet-group"
  subnet_ids = [
    aws_subnet.secondary_private_1.id,
    aws_subnet.secondary_private_2.id
  ]

  tags = {
    Name        = "Sierra Sync Secondary DB Subnet Group"
    Environment = "production"
  }
}

# Tertiary DB subnet group (eu-west-1)
resource "aws_db_subnet_group" "tertiary" {
  provider = aws.tertiary
  name     = "sierra-sync-tertiary-subnet-group"
  subnet_ids = [
    aws_subnet.tertiary_private_1.id,
    aws_subnet.tertiary_private_2.id
  ]

  tags = {
    Name        = "Sierra Sync Tertiary DB Subnet Group"
    Environment = "production"
  }
}

# Network infrastructure for primary region
resource "aws_vpc" "primary" {
  provider             = aws.primary
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "sierra-sync-primary-vpc"
    Environment = "production"
  }
}

resource "aws_subnet" "primary_private_1" {
  provider          = aws.primary
  vpc_id            = aws_vpc.primary.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = data.aws_availability_zones.primary.names[0]

  tags = {
    Name        = "sierra-sync-primary-private-1"
    Environment = "production"
  }
}

resource "aws_subnet" "primary_private_2" {
  provider          = aws.primary
  vpc_id            = aws_vpc.primary.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = data.aws_availability_zones.primary.names[1]

  tags = {
    Name        = "sierra-sync-primary-private-2"
    Environment = "production"
  }
}

# Network infrastructure for secondary region
resource "aws_vpc" "secondary" {
  provider             = aws.secondary
  cidr_block           = "10.1.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "sierra-sync-secondary-vpc"
    Environment = "production"
  }
}

resource "aws_subnet" "secondary_private_1" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.secondary.id
  cidr_block        = "10.1.1.0/24"
  availability_zone = data.aws_availability_zones.secondary.names[0]

  tags = {
    Name        = "sierra-sync-secondary-private-1"
    Environment = "production"
  }
}

resource "aws_subnet" "secondary_private_2" {
  provider          = aws.secondary
  vpc_id            = aws_vpc.secondary.id
  cidr_block        = "10.1.2.0/24"
  availability_zone = data.aws_availability_zones.secondary.names[1]

  tags = {
    Name        = "sierra-sync-secondary-private-2"
    Environment = "production"
  }
}

# Network infrastructure for tertiary region
resource "aws_vpc" "tertiary" {
  provider             = aws.tertiary
  cidr_block           = "10.2.0.0/16"
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "sierra-sync-tertiary-vpc"
    Environment = "production"
  }
}

resource "aws_subnet" "tertiary_private_1" {
  provider          = aws.tertiary
  vpc_id            = aws_vpc.tertiary.id
  cidr_block        = "10.2.1.0/24"
  availability_zone = data.aws_availability_zones.tertiary.names[0]

  tags = {
    Name        = "sierra-sync-tertiary-private-1"
    Environment = "production"
  }
}

resource "aws_subnet" "tertiary_private_2" {
  provider          = aws.tertiary
  vpc_id            = aws_vpc.tertiary.id
  cidr_block        = "10.2.2.0/24"
  availability_zone = data.aws_availability_zones.tertiary.names[1]

  tags = {
    Name        = "sierra-sync-tertiary-private-2"
    Environment = "production"
  }
}

# Security groups
resource "aws_security_group" "primary_db" {
  provider    = aws.primary
  name        = "sierra-sync-primary-db-sg"
  description = "Security group for primary database"
  vpc_id      = aws_vpc.primary.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.primary.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "sierra-sync-primary-db-sg"
    Environment = "production"
  }
}

resource "aws_security_group" "secondary_db" {
  provider    = aws.secondary
  name        = "sierra-sync-secondary-db-sg"
  description = "Security group for secondary database"
  vpc_id      = aws_vpc.secondary.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.secondary.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "sierra-sync-secondary-db-sg"
    Environment = "production"
  }
}

resource "aws_security_group" "tertiary_db" {
  provider    = aws.tertiary
  name        = "sierra-sync-tertiary-db-sg"
  description = "Security group for tertiary database"
  vpc_id      = aws_vpc.tertiary.id

  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.tertiary.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "sierra-sync-tertiary-db-sg"
    Environment = "production"
  }
}

# Parameter group for PostgreSQL optimization
resource "aws_db_parameter_group" "postgresql" {
  provider = aws.primary
  family   = "postgres15"
  name     = "sierra-sync-postgres-params"

  parameter {
    name  = "log_statement"
    value = "all"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "shared_preload_libraries"
    value = "pg_stat_statements"
  }

  parameter {
    name  = "max_connections"
    value = "200"
  }

  parameter {
    name  = "shared_buffers"
    value = "{DBInstanceClassMemory/4}"
  }

  parameter {
    name  = "effective_cache_size"
    value = "{DBInstanceClassMemory*3/4}"
  }

  parameter {
    name  = "maintenance_work_mem"
    value = "2097152"
  }

  parameter {
    name  = "checkpoint_completion_target"
    value = "0.9"
  }

  parameter {
    name  = "wal_buffers"
    value = "16384"
  }

  parameter {
    name  = "default_statistics_target"
    value = "100"
  }

  tags = {
    Name        = "sierra-sync-postgres-params"
    Environment = "production"
  }
}

# Primary RDS instance (us-east-1)
resource "aws_db_instance" "primary" {
  provider = aws.primary
  
  identifier     = "sierra-sync-primary"
  engine         = "postgres"
  engine_version = "15.4"
  instance_class = "db.r6g.xlarge"
  
  allocated_storage     = 500
  max_allocated_storage = 2000
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id           = aws_kms_key.primary_db_key.arn
  
  db_name  = "sierra_sync"
  username = "sierra_admin"
  password = random_password.db_password.result
  
  vpc_security_group_ids = [aws_security_group.primary_db.id]
  db_subnet_group_name   = aws_db_subnet_group.primary.name
  parameter_group_name   = aws_db_parameter_group.postgresql.name
  
  backup_retention_period = 30
  backup_window          = "03:00-04:00"
  maintenance_window     = "sun:04:00-sun:05:00"
  
  skip_final_snapshot       = false
  final_snapshot_identifier = "sierra-sync-primary-final-snapshot"
  copy_tags_to_snapshot     = true
  
  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_enhanced_monitoring.arn
  
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  
  performance_insights_enabled          = true
  performance_insights_kms_key_id      = aws_kms_key.primary_db_key.arn
  performance_insights_retention_period = 7
  
  deletion_protection = true
  
  tags = {
    Name        = "sierra-sync-primary"
    Environment = "production"
    Role        = "primary"
    Region      = "us-east-1"
  }
}

# Read replica in us-west-2
resource "aws_db_instance" "secondary_replica" {
  provider = aws.secondary
  
  identifier     = "sierra-sync-secondary"
  replicate_source_db = aws_db_instance.primary.arn
  instance_class = "db.r6g.large"
  
  vpc_security_group_ids = [aws_security_group.secondary_db.id]
  db_subnet_group_name   = aws_db_subnet_group.secondary.name
  
  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_enhanced_monitoring_secondary.arn
  
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  
  performance_insights_enabled          = true
  performance_insights_kms_key_id      = aws_kms_key.secondary_db_key.arn
  performance_insights_retention_period = 7
  
  skip_final_snapshot = true
  
  tags = {
    Name        = "sierra-sync-secondary"
    Environment = "production"
    Role        = "replica"
    Region      = "us-west-2"
  }
}

# Read replica in eu-west-1
resource "aws_db_instance" "tertiary_replica" {
  provider = aws.tertiary
  
  identifier     = "sierra-sync-tertiary"
  replicate_source_db = aws_db_instance.primary.arn
  instance_class = "db.r6g.large"
  
  vpc_security_group_ids = [aws_security_group.tertiary_db.id]
  db_subnet_group_name   = aws_db_subnet_group.tertiary.name
  
  monitoring_interval = 60
  monitoring_role_arn = aws_iam_role.rds_enhanced_monitoring_tertiary.arn
  
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  
  performance_insights_enabled          = true
  performance_insights_kms_key_id      = aws_kms_key.tertiary_db_key.arn
  performance_insights_retention_period = 7
  
  skip_final_snapshot = true
  
  tags = {
    Name        = "sierra-sync-tertiary"
    Environment = "production"
    Role        = "replica"
    Region      = "eu-west-1"
  }
}

# IAM role for enhanced monitoring (primary region)
resource "aws_iam_role" "rds_enhanced_monitoring" {
  provider = aws.primary
  name     = "rds-monitoring-role-primary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "rds-monitoring-role-primary"
    Environment = "production"
  }
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  provider   = aws.primary
  role       = aws_iam_role.rds_enhanced_monitoring.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# IAM role for enhanced monitoring (secondary region)
resource "aws_iam_role" "rds_enhanced_monitoring_secondary" {
  provider = aws.secondary
  name     = "rds-monitoring-role-secondary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "rds-monitoring-role-secondary"
    Environment = "production"
  }
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring_secondary" {
  provider   = aws.secondary
  role       = aws_iam_role.rds_enhanced_monitoring_secondary.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# IAM role for enhanced monitoring (tertiary region)
resource "aws_iam_role" "rds_enhanced_monitoring_tertiary" {
  provider = aws.tertiary
  name     = "rds-monitoring-role-tertiary"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "monitoring.rds.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "rds-monitoring-role-tertiary"
    Environment = "production"
  }
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring_tertiary" {
  provider   = aws.tertiary
  role       = aws_iam_role.rds_enhanced_monitoring_tertiary.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# Route53 for database endpoint failover
resource "aws_route53_zone" "private" {
  provider = aws.primary
  name     = "sierra-sync.internal"

  vpc {
    vpc_id = aws_vpc.primary.id
  }

  tags = {
    Name        = "sierra-sync-internal"
    Environment = "production"
  }
}

# Primary database endpoint
resource "aws_route53_record" "db_primary" {
  provider = aws.primary
  zone_id  = aws_route53_zone.private.zone_id
  name     = "db-primary.sierra-sync.internal"
  type     = "CNAME"
  ttl      = 60
  records  = [aws_db_instance.primary.endpoint]
}

# Read replica endpoints
resource "aws_route53_record" "db_secondary" {
  provider = aws.primary
  zone_id  = aws_route53_zone.private.zone_id
  name     = "db-secondary.sierra-sync.internal"
  type     = "CNAME"
  ttl      = 60
  records  = [aws_db_instance.secondary_replica.endpoint]
}

resource "aws_route53_record" "db_tertiary" {
  provider = aws.primary
  zone_id  = aws_route53_zone.private.zone_id
  name     = "db-tertiary.sierra-sync.internal"
  type     = "CNAME"
  ttl      = 60
  records  = [aws_db_instance.tertiary_replica.endpoint]
}

# Weighted routing for read replicas
resource "aws_route53_record" "db_read" {
  provider = aws.primary
  zone_id  = aws_route53_zone.private.zone_id
  name     = "db-read.sierra-sync.internal"
  type     = "CNAME"
  ttl      = 60

  weighted_routing_policy {
    weight = 50
  }

  set_identifier = "secondary"
  records        = [aws_db_instance.secondary_replica.endpoint]
}

resource "aws_route53_record" "db_read_tertiary" {
  provider = aws.primary
  zone_id  = aws_route53_zone.private.zone_id
  name     = "db-read.sierra-sync.internal"
  type     = "CNAME"
  ttl      = 60

  weighted_routing_policy {
    weight = 50
  }

  set_identifier = "tertiary"
  records        = [aws_db_instance.tertiary_replica.endpoint]
}

# CloudWatch alarms for database monitoring
resource "aws_cloudwatch_metric_alarm" "primary_db_cpu" {
  provider            = aws.primary
  alarm_name          = "sierra-sync-primary-db-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = "120"
  statistic           = "Average"
  threshold           = "80"
  alarm_description   = "This metric monitors primary database cpu utilization"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.primary.id
  }

  tags = {
    Name        = "sierra-sync-primary-db-cpu"
    Environment = "production"
  }
}

resource "aws_cloudwatch_metric_alarm" "primary_db_connections" {
  provider            = aws.primary
  alarm_name          = "sierra-sync-primary-db-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = "60"
  statistic           = "Average"
  threshold           = "160"
  alarm_description   = "This metric monitors primary database connections"
  alarm_actions       = [aws_sns_topic.alerts.arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.primary.id
  }

  tags = {
    Name        = "sierra-sync-primary-db-connections"
    Environment = "production"
  }
}

resource "aws_cloudwatch_metric_alarm" "replica_lag_secondary" {
  provider            = aws.secondary
  alarm_name          = "sierra-sync-secondary-replica-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = "2"
  metric_name         = "ReplicaLag"
  namespace           = "AWS/RDS"
  period              = "60"
  statistic           = "Average"
  threshold           = "300"
  alarm_description   = "This metric monitors secondary replica lag"
  alarm_actions       = [aws_sns_topic.alerts_secondary.arn]

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.secondary_replica.id
  }

  tags = {
    Name        = "sierra-sync-secondary-replica-lag"
    Environment = "production"
  }
}

# SNS topics for alerts
resource "aws_sns_topic" "alerts" {
  provider = aws.primary
  name     = "sierra-sync-db-alerts"

  tags = {
    Name        = "sierra-sync-db-alerts"
    Environment = "production"
  }
}

resource "aws_sns_topic" "alerts_secondary" {
  provider = aws.secondary
  name     = "sierra-sync-db-alerts-secondary"

  tags = {
    Name        = "sierra-sync-db-alerts-secondary"
    Environment = "production"
  }
}

# Outputs
output "primary_db_endpoint" {
  description = "Primary database endpoint"
  value       = aws_db_instance.primary.endpoint
  sensitive   = true
}

output "secondary_db_endpoint" {
  description = "Secondary database endpoint"
  value       = aws_db_instance.secondary_replica.endpoint
  sensitive   = true
}

output "tertiary_db_endpoint" {
  description = "Tertiary database endpoint"
  value       = aws_db_instance.tertiary_replica.endpoint
  sensitive   = true
}

output "database_password" {
  description = "Database password"
  value       = random_password.db_password.result
  sensitive   = true
}

output "primary_kms_key_id" {
  description = "Primary region KMS key ID"
  value       = aws_kms_key.primary_db_key.key_id
}

output "secondary_kms_key_id" {
  description = "Secondary region KMS key ID"
  value       = aws_kms_key.secondary_db_key.key_id
}

output "tertiary_kms_key_id" {
  description = "Tertiary region KMS key ID"
  value       = aws_kms_key.tertiary_db_key.key_id
}