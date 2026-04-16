#!/usr/bin/env bash
# Explain why kubectl hits localhost:8080 and what to do next.
set -euo pipefail

echo "=== kubectl / kubeconfig check ==="
echo ""

KCFG="${KUBECONFIG:-$HOME/.kube/config}"
if [[ -n "${KUBECONFIG:-}" ]]; then
  echo "KUBECONFIG is set (first file used by kubectl): ${KUBECONFIG%%:*}"
fi

if [[ ! -f "$HOME/.kube/config" ]] || [[ ! -s "$HOME/.kube/config" ]]; then
  echo "PROBLEM: Missing or empty ~/.kube/config"
  echo "  kubectl then defaults to http://127.0.0.1:8080 → connection refused"
  echo ""
  echo "FIX: Create a local cluster so kubeconfig is written. Pick ONE:"
  echo "  • Minikube:  minikube start   (then: kubectl cluster-info)"
  echo "  • kind:      kind create cluster"
  echo "  • MicroK8s:  sudo snap install microk8s --classic && mkdir -p ~/.kube && sudo microk8s config > ~/.kube/config"
  echo ""
  echo "See README section \"Local Kubernetes cluster\"."
  exit 1
fi

echo "OK: ~/.kube/config exists ($(wc -c <"$HOME/.kube/config") bytes)"
echo ""
echo "Contexts:"
kubectl config get-contexts 2>/dev/null || true
echo ""
if ! kubectl config current-context &>/dev/null; then
  echo "PROBLEM: No current context selected."
  echo "FIX: kubectl config use-context <name>   (pick a name from the table above)"
  exit 1
fi

echo "Current context: $(kubectl config current-context)"
echo ""
if kubectl cluster-info &>/dev/null; then
  echo "OK: cluster is reachable."
  exit 0
fi

echo "PROBLEM: kubeconfig exists but API server is not reachable (cluster down or wrong URL)."
echo "FIX: start the cluster (e.g. minikube start) or fix VPN/firewall / server URL in ~/.kube/config"
exit 1
