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
- A **running Kubernetes cluster** and a valid **`~/.kube/config`** (see below if `kubectl` fails)

## Local Kubernetes cluster (fix `localhost:8080` / connection refused)

If `kubectl cluster-info` shows **`connection refused`** to **`127.0.0.1:8080`**, kubectl has **no real cluster** configured: usually **missing or empty `~/.kube/config`**, or **no current context**. This repo does not install Kubernetes for you—you must run a cluster locally or point kubeconfig at a cloud cluster.

Run the project helper (prints the same guidance):

```bash
npm run diagnose:kubectl
```

### Option A — Minikube (common on Ubuntu VMs)

Requires a driver ([install Minikube](https://minikube.sigs.k8s.io/docs/start/)). With Docker installed:

```bash
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube
minikube start
kubectl cluster-info
```

Use `IS_MINIKUBE=true` in `.env` (or `pulumi config set isMinikube true`) for this project’s NodePort defaults.

### Option B — kind (needs [Docker](https://docs.docker.com/engine/install/ubuntu/))

```bash
# install kind from https://kind.sigs.k8s.io/docs/user/quick-start/#installation
kind create cluster
kubectl cluster-info
```

### Option C — MicroK8s

```bash
sudo snap install microk8s --classic
sudo microk8s status --wait-ready
mkdir -p ~/.kube
sudo microk8s config > ~/.kube/config
chmod 600 ~/.kube/config
kubectl cluster-info
```

### After the cluster works

```bash
kubectl get nodes
cd kubernetes-ts-guestbook-monitoring
pulumi up
```

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
| `GRAFANA_NODE_PORT` | Minikube only: fixed **NodePort** for Grafana (default **31302**). Used so `pulumi preview` does not read the Service from the API (Helm `Release` does not expose it as a Pulumi child resource). |
| `KUBE_PROM_HELM_RELEASE_NAME` | Helm release name for kube-prometheus-stack (default **`gbmkps`**). Change only if it collides with an existing Helm release. |
| `GRAFANA_HELM_FULLNAME` | Grafana subchart `fullnameOverride` (default **`gbmon-grafana`**). Sets Service / ClusterRole name prefix; change if it collides. |
| `KUBE_PROM_STACK_VERSION` | Optional override for the kube-prometheus-stack Helm chart version. |
| `BLACKBOX_EXPORTER_VERSION` | Optional override for the blackbox-exporter Helm chart version. |
| `PROMETHEUS_OPERATOR_CRDS_VERSION` | Optional override for the `prometheus-operator-crds` chart (default **13.0.0** → operator **v0.75.x**, aligned with kube-prometheus-stack **61.7.x**). |
| `KUBECONFIG_PATH` | Optional absolute path to your kubeconfig if `kubectl` works but the default path is wrong. |

Do **not** commit `.env` (it is listed in `.gitignore`).

### Pulumi stack config (alternative to `.env`)

| Key | Description |
| --- | --- |
| `isMinikube` | Same meaning as `IS_MINIKUBE` when the env var is unset. |
| `grafanaAdminPassword` | Same meaning as `GRAFANA_ADMIN_PASSWORD` when the env var is unset. |
| `kubeconfigPath` | Same meaning as `KUBECONFIG_PATH` when the env var is unset (absolute path to kubeconfig). |

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
    minikube service gbmon-grafana -n monitoring --url
    ```

    With **Minikube**, Grafana uses a **fixed NodePort** (default **31302**, overridable via **`GRAFANA_NODE_PORT`** in `.env`) so `pulumi preview` does not need the Service to exist yet. The `grafanaUrl` output shows `127.0.0.1:<port>`; `minikube service …` resolves the correct node address.

  - **LoadBalancer:** `grafanaUrl` is a short hint; run `kubectl get svc gbmon-grafana -n monitoring -o wide` for the external address once the cloud provider assigns it. (Override the Grafana Kubernetes name with **`GRAFANA_HELM_FULLNAME`** in `.env` if needed.)

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

- **`kubectl cluster-info` → `localhost:8080` / connection refused:** You have no kubeconfig or no cluster—see **[Local Kubernetes cluster](#local-kubernetes-cluster-fix-localhost8080--connection-refused)** above. Run `npm run diagnose:kubectl`.
- **“Kubernetes cluster is unreachable” / “no configuration has been provided” (Pulumi):** Same root cause: fix `kubectl cluster-info` first, then set `KUBECONFIG` / `KUBECONFIG_PATH` in `.env` / `kubeconfigPath` in Pulumi config if your config is not at `~/.kube/config`.
- **Helm fetch timeouts:** ensure outbound HTTPS to `https://prometheus-community.github.io/helm-charts` is allowed.
- **“no matches for kind ServiceMonitor / PrometheusRule” (CRDs missing):** Monitoring CRDs are installed with **`helm.v3.Release`** for **`prometheus-operator-crds`**, then **`kube-prometheus-stack`** (also a **Release**), so Helm applies CRDs before other manifests. If you previously deployed an older revision that used **`helm.v3.Chart`**, the first `pulumi up` after pulling this change may replace a large set of resources; if the plan looks wrong or stuck, run **`pulumi destroy`** once, then **`pulumi up`**. If you change `KUBE_PROM_STACK_VERSION`, bump **`PROMETHEUS_OPERATOR_CRDS_VERSION`** to match that chart’s `appVersion` (Prometheus Operator release).
- **Helm: `exists and cannot be imported ... missing key "meta.helm.sh/release-name"`** (often on **`ServiceAccount`**, **`ClusterRole`**, etc.): Leftovers from the old **Pulumi `Chart`** are not owned by Helm. **ClusterRoles** survive `kubectl delete namespace monitoring`, so you must clean them too. This repo uses a **new Helm release name** (`gbmkps` by default) and Grafana **`fullnameOverride`** (`gbmon-grafana` by default) to avoid colliding with old `kps` / `guestbook-grafana-*` names on fresh installs. **If you still have old objects**, run the reset script (it deletes legacy `guestbook-grafana*` / `kps-kube-prometheus-stack*` **ClusterRole**s and webhooks, then the namespace):

  ```bash
  npm run fix:monitoring-ns   # interactive; or: RESET_MONITORING_CONFIRM=YES npm run fix:monitoring-ns
  pulumi refresh --yes
  pulumi up
  ```

  Alternatively run **`pulumi destroy`** (removes Guestbook too) and **`pulumi up`** for a full clean slate.
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
