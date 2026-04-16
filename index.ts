import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/** Resolve the folder containing `Pulumi.yaml` by walking up from cwd so `.env` loads even if the shell cwd differs. */
function findPulumiProjectRoot(): string {
    let dir = path.resolve(process.cwd());
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, "Pulumi.yaml"))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return path.resolve(process.cwd());
}

const projectRoot = findPulumiProjectRoot();
// Load `.env` next to Pulumi.yaml. Existing `process.env` entries win over the file (dotenv default).
loadEnv({ path: path.join(projectRoot, ".env") });

function envBool(key: string, fallback: boolean): boolean {
    const v = process.env[key];
    if (v === undefined || v === "") {
        return fallback;
    }
    return /^(1|true|yes|on)$/i.test(v);
}

function envString(key: string, fallback: string): string {
    const v = process.env[key];
    return v !== undefined && v !== "" ? v : fallback;
}

const config = new pulumi.Config();
const isMinikube = envBool("IS_MINIKUBE", config.getBoolean("isMinikube") ?? true);

const grafanaPasswordFromEnv = process.env.GRAFANA_ADMIN_PASSWORD;
const grafanaAdminPassword = grafanaPasswordFromEnv
    ? pulumi.secret(grafanaPasswordFromEnv)
    : (config.getSecret("grafanaAdminPassword") ?? pulumi.secret("changeme"));

const prometheusCommunityRepo = "https://prometheus-community.github.io/helm-charts";
const kubePromStackVersion = envString("KUBE_PROM_STACK_VERSION", "61.7.2");
const blackboxExporterVersion = envString("BLACKBOX_EXPORTER_VERSION", "8.17.0");

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// Blackbox exporter (HTTP probes against the Guestbook frontend).
const blackboxExporter = new k8s.helm.v3.Chart(
    "blackbox",
    {
        chart: "prometheus-blackbox-exporter",
        version: blackboxExporterVersion,
        namespace: monitoringNamespace.metadata.name,
        fetchOpts: { repo: prometheusCommunityRepo },
        values: {
            fullnameOverride: "blackbox-exporter",
            serviceMonitor: { enabled: false },
        },
    },
    { dependsOn: [monitoringNamespace] },
);

const blackboxAddress = "blackbox-exporter.monitoring.svc.cluster.local:9115";

const kubePromStack = new k8s.helm.v3.Chart(
    "kps",
    {
        chart: "kube-prometheus-stack",
        version: kubePromStackVersion,
        namespace: monitoringNamespace.metadata.name,
        fetchOpts: { repo: prometheusCommunityRepo },
        values: {
            prometheus: {
                prometheusSpec: {
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    podMonitorSelectorNilUsesHelmValues: false,
                    serviceMonitorNamespaceSelector: { any: true },
                    podMonitorNamespaceSelector: { any: true },
                    additionalScrapeConfigs: [
                        {
                            job_name: "blackbox-frontend",
                            metrics_path: "/probe",
                            params: { module: ["http_2xx"] },
                            static_configs: [{ targets: ["http://frontend.default.svc.cluster.local"] }],
                            relabel_configs: [
                                { source_labels: ["__address__"], target_label: "__param_target" },
                                { source_labels: ["__param_target"], target_label: "instance" },
                                { target_label: "__address__", replacement: blackboxAddress },
                                { source_labels: ["__param_target"], target_label: "__param_target" },
                            ],
                        },
                    ],
                },
            },
            grafana: {
                fullnameOverride: "guestbook-grafana",
                adminUser: "admin",
                adminPassword: grafanaAdminPassword,
                service: {
                    type: isMinikube ? "NodePort" : "LoadBalancer",
                },
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        labelValue: "1",
                    },
                },
            },
        },
    },
    { dependsOn: [monitoringNamespace, blackboxExporter] },
);

//
// Guestbook (same topology as kubernetes-ts-guestbook/simple)
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis:7.2-alpine",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});

const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                ],
            },
        },
    },
});

const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});

const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [{ port: 80 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

//
// Redis exporters (Prometheus metrics for Redis leader + replica).
//

const redisLeaderExporterLabels = { app: "redis-leader-exporter" };
const redisLeaderExporterDeployment = new k8s.apps.v1.Deployment(
    "redis-leader-exporter",
    {
        spec: {
            selector: { matchLabels: redisLeaderExporterLabels },
            replicas: 1,
            template: {
                metadata: { labels: redisLeaderExporterLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-exporter",
                            image: "oliver006/redis_exporter:v1.62.0-alpine",
                            args: ["--redis.addr=redis://redis-leader.default.svc.cluster.local:6379"],
                            ports: [{ name: "metrics", containerPort: 9121 }],
                        },
                    ],
                },
            },
        },
    },
    { dependsOn: [redisLeaderService] },
);

const redisLeaderExporterService = new k8s.core.v1.Service("redis-leader-exporter", {
    metadata: {
        name: "redis-leader-exporter",
        labels: redisLeaderExporterLabels,
    },
    spec: {
        ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        selector: redisLeaderExporterLabels,
    },
});

const redisReplicaExporterLabels = { app: "redis-replica-exporter" };
const redisReplicaExporterDeployment = new k8s.apps.v1.Deployment(
    "redis-replica-exporter",
    {
        spec: {
            selector: { matchLabels: redisReplicaExporterLabels },
            replicas: 1,
            template: {
                metadata: { labels: redisReplicaExporterLabels },
                spec: {
                    containers: [
                        {
                            name: "redis-exporter",
                            image: "oliver006/redis_exporter:v1.62.0-alpine",
                            args: ["--redis.addr=redis://redis-replica.default.svc.cluster.local:6379"],
                            ports: [{ name: "metrics", containerPort: 9121 }],
                        },
                    ],
                },
            },
        },
    },
    { dependsOn: [redisReplicaService] },
);

const redisReplicaExporterService = new k8s.core.v1.Service("redis-replica-exporter", {
    metadata: {
        name: "redis-replica-exporter",
        labels: redisReplicaExporterLabels,
    },
    spec: {
        ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        selector: redisReplicaExporterLabels,
    },
});

const smOpts: pulumi.CustomResourceOptions = { dependsOn: [kubePromStack, redisLeaderExporterService] };

new k8s.apiextensions.CustomResource(
    "sm-redis-leader-exporter",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "redis-leader-exporter",
            namespace: "default",
        },
        spec: {
            endpoints: [{ port: "metrics", interval: "30s", scrapeTimeout: "10s" }],
            selector: {
                matchLabels: redisLeaderExporterLabels,
            },
        },
    },
    smOpts,
);

new k8s.apiextensions.CustomResource(
    "sm-redis-replica-exporter",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: {
            name: "redis-replica-exporter",
            namespace: "default",
        },
        spec: {
            endpoints: [{ port: "metrics", interval: "30s", scrapeTimeout: "10s" }],
            selector: {
                matchLabels: redisReplicaExporterLabels,
            },
        },
    },
    { dependsOn: [kubePromStack, redisReplicaExporterService] },
);

// Provisioned dashboard (sidecar picks up ConfigMaps in the Grafana namespace).
const dashboardJsonPath = path.join(projectRoot, "dashboards", "guestbook.json");
const dashboardJson = fs.readFileSync(dashboardJsonPath, "utf8");
new k8s.core.v1.ConfigMap(
    "guestbook-grafana-dashboard",
    {
        metadata: {
            name: "guestbook-grafana-dashboard",
            namespace: monitoringNamespace.metadata.name,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook.json": dashboardJson },
    },
    { dependsOn: [kubePromStack] },
);

const grafanaService = kubePromStack.getResource("v1/Service", "monitoring", "guestbook-grafana");

const grafanaNodePort = grafanaService.spec.apply((spec) => {
    const ports = spec?.ports ?? [];
    const match = ports.find((p) => p.name === "http-web" || p.port === 80);
    return match?.nodePort ?? ports[0]?.nodePort ?? 0;
});

export const frontendIp: pulumi.Output<string> = isMinikube
    ? frontendService.spec.clusterIP
    : frontendService.status.loadBalancer.ingress.apply((ing) =>
          ing?.[0]?.ip ?? ing?.[0]?.hostname ?? "pending",
      );

export const grafanaAdminUser = "admin";
export const grafanaAdminPasswordOut = grafanaAdminPassword;

/** Minikube: use `minikube service guestbook-grafana -n monitoring --url` for the correct URL. */
export const grafanaUrl = isMinikube
    ? pulumi.interpolate`http://127.0.0.1:${grafanaNodePort} (or run: minikube service guestbook-grafana -n monitoring --url)`
    : grafanaService.status.apply((st) => {
          const ing = st?.loadBalancer?.ingress?.[0];
          const host = ing?.hostname ?? ing?.ip;
          return host ? `http://${host}` : "pending LoadBalancer hostname/IP";
      });

export const verifyMetricsHint =
    "kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090 (or svc/prometheus-kps-kube-prometheus-prometheus). Prometheus UI → Status → Targets: look for redis-leader-exporter, redis-replica-exporter, blackbox-frontend. PromQL: redis_connected_clients, probe_success{job=\"blackbox-frontend\"}";
