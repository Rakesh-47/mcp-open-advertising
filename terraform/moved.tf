# State moves for the switch from 13 per-server module blocks to one
# `module "mcp_service"` with for_each. Without them Terraform would destroy
# every Cloud Run service and create it again under the new address.
#
# This list is a record of the servers that existed at the switch. A server
# added later needs no entry here.

moved {
  from = module.dbm_mcp
  to   = module.mcp_service["dbm-mcp"]
}

moved {
  from = module.dv360_mcp
  to   = module.mcp_service["dv360-mcp"]
}

moved {
  from = module.ttd_mcp
  to   = module.mcp_service["ttd-mcp"]
}

moved {
  from = module.gads_mcp
  to   = module.mcp_service["gads-mcp"]
}

moved {
  from = module.meta_mcp
  to   = module.mcp_service["meta-mcp"]
}

moved {
  from = module.linkedin_mcp
  to   = module.mcp_service["linkedin-mcp"]
}

moved {
  from = module.tiktok_mcp
  to   = module.mcp_service["tiktok-mcp"]
}

moved {
  from = module.cm360_mcp
  to   = module.mcp_service["cm360-mcp"]
}

moved {
  from = module.snapchat_mcp
  to   = module.mcp_service["snapchat-mcp"]
}

moved {
  from = module.sa360_mcp
  to   = module.mcp_service["sa360-mcp"]
}

moved {
  from = module.pinterest_mcp
  to   = module.mcp_service["pinterest-mcp"]
}

moved {
  from = module.amazon_dsp_mcp
  to   = module.mcp_service["amazon-dsp-mcp"]
}

moved {
  from = module.msads_mcp
  to   = module.mcp_service["msads-mcp"]
}
