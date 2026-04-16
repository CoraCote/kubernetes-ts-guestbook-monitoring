#!/usr/bin/env bash
# Verify a deployed stack: monitoring namespace, Grafana, Prometheus, Guestbook, ServiceMonitors.
# Requires kubectl configured and resources from `pulumi up`.
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

ok() { echo -e "${GREEN}OK${NC} $*"; }
bad() { echo -e "${RED}MISSING${NC} $*"; exit 1; }

kubectl cluster-info &>/dev/null || bad "kubectl cannot reach a cluster"

kubectl get ns monitoring &>/dev/null || bad "namespace monitoring not found — run pulumi up"

kubectl get svc -n monitoring guestbook-grafana &>/dev/null || bad "Grafana service guestbook-grafana not found in monitoring"

kubectl get pods -n monitoring -l app.kubernetes.io/name=grafana --no-headers 2>/dev/null | grep -q Running || \
  bad "Grafana pod not Running in monitoring"

kubectl get svc frontend -n default &>/dev/null || bad "Guestbook frontend Service not found in default"

kubectl get servicemonitor -n default redis-leader-exporter &>/dev/null || \
  bad "ServiceMonitor redis-leader-exporter not found in default"

kubectl get servicemonitor -n default redis-replica-exporter &>/dev/null || \
  bad "ServiceMonitor redis-replica-exporter not found in default"

# Prometheus operator-managed Prometheus Service (common names across chart versions)
PROM_SVC=""
for name in prometheus-operated prometheus-kps-kube-prometheus-prometheus kps-kube-prometheus-prometheus; do
  if kubectl get svc -n monitoring "$name" &>/dev/null; then
    PROM_SVC="$name"
    break
  fi
done
if [[ -z "$PROM_SVC" ]]; then
  echo "WARN: could not find a known Prometheus Service name; list with: kubectl get svc -n monitoring | grep -i prom"
else
  ok "Prometheus service: monitoring/$PROM_SVC"
fi

ok "Cluster checks passed. Next: port-forward Prometheus and open Status → Targets, or open Grafana (see README)."
