# Root Terraform outputs

output "service_urls" {
  description = "Cloud Run URL per MCP service, keyed by package name"
  value       = { for name, svc in module.mcp_service : name => svc.cloud_run_service_url }
}

output "vpc_name" {
  value = module.networking.vpc_name
}

output "vpc_connector_name" {
  value = module.networking.vpc_connector_name
}

output "cloud_nat_name" {
  value = module.networking.cloud_nat_name
}

output "deployment_info" {
  value = {
    project_id   = var.project_id
    region       = var.region
    environment  = var.environment
    service_urls = { for name, svc in module.mcp_service : name => svc.cloud_run_service_url }
  }
}

output "fleet_lb_ip" {
  description = "Global IP of the fleet load balancer — create a DNS-only A record for fleet_domain pointing here"
  value       = var.enable_fleet_lb ? module.fleet_lb[0].ip_address : null
}

output "fleet_lb_service_urls" {
  description = "Per-service base URLs behind the fleet load balancer"
  value       = var.enable_fleet_lb ? module.fleet_lb[0].service_urls : null
}
