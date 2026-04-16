# Guestbook with Prometheus and Grafana (Pulumi)

This project extends the [Pulumi Kubernetes Guestbook](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook) with:

- **kube-prometheus-stack** (Helm): Prometheus Operator, Prometheus, Grafana, kube-state-metrics, node-exporter defaults
- **prometheus-blackbox-exporter** (Helm): HTTP probes against the Guestbook `frontend` Service
- **redis_exporter** Deployments + **ServiceMonitor** resources for Redis leader and replica metrics
- A **Grafana dashboard** (`Guestbook overview`) loaded from a `ConfigMap` via the Grafana sidecar

## Prerequisites

- Pulumi CLI and a Pulumi account (optional for local backend)
- Node.js 18+
- `kubectl` configured for your cluster
- Enough resources for kube-prometheus-stack (several pods in `monitoring`)

## Configuration

| Key | Description |
| --- | --- |
| `isMinikube` | `true` (default): Guestbook frontend stays `ClusterIP`; Grafana uses **NodePort**. `false`: frontend `LoadBalancer` where supported; Grafana **LoadBalancer**. |
| `grafanaAdminPassword` | **Recommended:** set a strong secret: `pulumi config set --secret grafanaAdminPassword '<password>'`. If unset, the program defaults to `changeme` (not for production). |

Examples:

```bash
cd kubernetes-ts-guestbook-monitoring
pulumi stack init dev
pulumi config set isMinikube true
pulumi config set --secret grafanaAdminPassword 'YourSecurePassword'
```

## Deploy

```bash
npm install
pulumi up
```

## Grafana access

After `pulumi up`:

- **Username:** `admin` (exported as `grafanaAdminUser`).
- **Password:** the value you set in `grafanaAdminPassword`, or the default if you did not set it. Retrieve secret outputs with:

  ```bash
  pulumi stack output grafanaAdminPasswordOut --show-secrets
  ```

- **URL:** stack output `grafanaUrl`.

  - **Minikube:** Prefer the printed helper, or run:

    ```bash
    minikube service guestbook-grafana -n monitoring --url
    ```

    The `grafanaUrl` output includes a `127.0.0.1:<nodePort>` hint; the minikube command resolves the correct node address.

  - **LoadBalancer:** open the `http://` URL from `grafanaUrl` once the cloud provider assigns an address.

### Dashboard

Open **Dashboards → Guestbook overview** (or search `guestbook`). Panels include Redis clients, blackbox probe success/duration for the frontend, and frontend pod CPU from cAdvisor.

## Verify Guestbook metrics in Prometheus

1. Find the Prometheus service (name varies slightly by chart version):

   ```bash
   kubectl get svc -n monitoring | findstr prometheus
   ```

   Common patterns: `prometheus-operated` (operator-managed) or a `prometheus-kps-*` service.

2. Port-forward the Prometheus UI (example — adjust the service name to match your cluster):

   ```bash
   kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090
   ```

   If that service does not exist, use the ClusterIP service that targets port `9090` from the list above.

3. Open `http://localhost:9090` → **Status → Targets**. Confirm targets are **UP** for:

   - Redis exporter `ServiceMonitor` endpoints (names contain `redis-leader-exporter` / `redis-replica-exporter`)
   - The **blackbox-frontend** job (additional scrape config)

4. In **Graph**, try:

   - `redis_connected_clients`
   - `probe_success{job="blackbox-frontend"}`
   - `probe_duration_seconds{job="blackbox-frontend"}`

The stack also exports `verifyMetricsHint` with a short reminder.

## Architecture notes

- **Frontend “metrics”:** The stock PHP Guestbook image does not expose `/metrics`. HTTP reachability and latency are observed via **Blackbox** probes against `http://frontend.default.svc.cluster.local`.
- **Backend metrics:** **redis_exporter** scrapes Redis leader and replica for standard Redis metrics.
- **Resource usage:** Frontend pod CPU uses `container_cpu_usage_seconds_total` from the default Kubernetes/cAdvisor scrape configuration included in kube-prometheus-stack.

## Troubleshooting

- **Helm fetch timeouts:** ensure outbound HTTPS to `https://prometheus-community.github.io/helm-charts` is allowed.
- **CRD / ServiceMonitor errors on first deploy:** re-run `pulumi up` once CRDs are fully established.
- **Blackbox target down:** ensure the `frontend` Service exists in `default` and returns HTTP 2xx on `/`.
- **Grafana dashboard empty:** confirm the Prometheus datasource UID in Grafana is `prometheus` (default for this stack). If your stack uses a different UID, edit [dashboards/guestbook.json](dashboards/guestbook.json) datasource blocks.

## License

MIT
