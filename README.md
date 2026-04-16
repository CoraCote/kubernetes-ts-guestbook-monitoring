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

### Environment file (`.env`)

The program loads [dotenv](https://github.com/motdotla/dotenv) from a **`.env`** file next to **`Pulumi.yaml`** (the project root is found by walking up from the current working directory). Variables in **`.env`** override Pulumi stack config for the same settings when you run `pulumi preview` / `pulumi up` (already-exported `process.env` values still win over the file).

1. Copy the example file and edit values:

   ```bash
   cp .env.example .env
   ```

2. Common variables:

| Variable | Description |
| --- | --- |
| `IS_MINIKUBE` | `true` / `1` / `yes`: Guestbook frontend stays `ClusterIP`; Grafana uses **NodePort**. `false`: frontend **LoadBalancer** where supported; Grafana **LoadBalancer**. |
| `GRAFANA_ADMIN_PASSWORD` | Grafana `admin` password (stored as a Pulumi secret in state). Prefer a strong value in production. |
| `KUBE_PROM_STACK_VERSION` | Optional override for the kube-prometheus-stack Helm chart version. |
| `BLACKBOX_EXPORTER_VERSION` | Optional override for the blackbox-exporter Helm chart version. |

Do **not** commit `.env` (it is listed in `.gitignore`).

### Pulumi stack config (alternative to `.env`)

| Key | Description |
| --- | --- |
| `isMinikube` | Same meaning as `IS_MINIKUBE` when the env var is unset. |
| `grafanaAdminPassword` | Same meaning as `GRAFANA_ADMIN_PASSWORD` when the env var is unset. |

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
cp .env.example .env   # optional: set IS_MINIKUBE and GRAFANA_ADMIN_PASSWORD
pulumi up
```

### Automated checks (no cluster)

```bash
npm test
```

### After deploy (cluster verification)

With `kubectl` pointed at the same cluster:

```bash
npm run verify:cluster
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

## Submission checklist (assignment)

- [x] Pulumi deploys **Prometheus** and **Grafana** (kube-prometheus-stack Helm chart).
- [x] Guestbook **frontend** observed via **Blackbox** HTTP probes; **backend (Redis)** via **redis_exporter** + **ServiceMonitor** resources.
- [x] Simple metrics: probe success/duration, Redis clients, frontend pod CPU (cAdvisor).
- [x] Grafana exposed as **NodePort** (minikube) or **LoadBalancer** (cloud).
- [x] Stack outputs: **`grafanaUrl`**, **`grafanaAdminUser`**, **`grafanaAdminPasswordOut`** (use `--show-secrets` for the password).
- [x] Optional Grafana dashboard: **Dashboards → Guestbook overview** (ConfigMap + sidecar).
- [x] **`.env`** supported for `IS_MINIKUBE`, `GRAFANA_ADMIN_PASSWORD`, and optional chart versions.
- [x] Local test: `npm test`; cluster smoke test: `npm run verify:cluster`.

## License

MIT
