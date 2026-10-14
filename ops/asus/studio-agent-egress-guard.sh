#!/usr/bin/env bash
# Egress guard (every 15 s): a running agent without its egress table or proxy is stopped.
# The unit's IPAddressAllow layer alone is port-agnostic, so a vanished nft table must not leave the agent running.
set -u
systemctl is-active --quiet studio-agent.service || exit 0
if ! nft list table inet studio_agent >/dev/null 2>&1; then
  echo "guard: nft table inet studio_agent missing; stopping studio-agent"
  systemctl stop studio-agent.service
  exit 0
fi
if ! systemctl is-active --quiet studio-proxy.service; then
  echo "guard: studio-proxy.service inactive; stopping studio-agent"
  systemctl stop studio-agent.service
fi
exit 0
