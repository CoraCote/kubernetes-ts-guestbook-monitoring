#!/usr/bin/env bash
# Clean up legacy monitoring stack + Helm migration leftovers, then remove namespace "monitoring".
#
# Fixes Helm Release errors like:
#   ClusterRole "guestbook-grafana-clusterrole" exists and cannot be imported ...
# (cluster-scoped RBAC survives `kubectl delete ns monitoring`.)
#
# CRDs stay cluster-scoped; this script does not delete CRDs.
set -euo pipefail

NS=monitoring

delete_by_name_grep() {
  local api="$1"
  local pattern="$2"
  kubectl get "$api" -o name 2>/dev/null | grep -E "$pattern" | while read -r r; do
    echo "Deleting $r ..."
    kubectl delete "$r" --ignore-not-found --wait=true
  done
}

echo "This will:"
echo "  1) Delete legacy cluster-scoped objects from old Pulumi Chart / Helm name 'kps' / Grafana name 'guestbook-grafana'"
echo "  2) Delete namespace '${NS}' (workloads + Helm metadata in that NS)"
echo "Guestbook in 'default' is not removed."
echo ""

if [[ "${RESET_MONITORING_CONFIRM:-}" != "YES" ]]; then
  read -r -p "Type YES to continue: " ans
  if [[ "$ans" != "YES" ]]; then
    echo "Aborted."
    exit 1
  fi
fi

echo "== Cluster-scoped cleanup (RBAC / admission) =="
delete_by_name_grep clusterroles 'guestbook-grafana|kps-kube-prometheus-stack'
delete_by_name_grep clusterrolebindings 'guestbook-grafana|kps-kube-prometheus-stack'
delete_by_name_grep validatingwebhookconfigurations 'kps-kube-prometheus-stack'
delete_by_name_grep mutatingwebhookconfigurations 'kps-kube-prometheus-stack'

echo "== Namespace ${NS} =="
kubectl delete namespace "${NS}" --ignore-not-found --wait=true

echo ""
echo "Done. Next:"
echo "  pulumi refresh --yes"
echo "  pulumi up"
