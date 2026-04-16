import { config as loadEnv } from "dotenv";
import * as fs from "fs";
import * as os from "os";
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

/** Stable Grafana NodePort when using Minikube (Helm Release has no Pulumi child Service to read at preview time). */
const grafanaServiceNodePort = (() => {
    const p = Number.parseInt(envString("GRAFANA_NODE_PORT", "31302"), 10);
    return Number.isFinite(p) && p >= 30000 && p <= 32767 ? p : 31302;
})();

const grafanaPasswordFromEnv = process.env.GRAFANA_ADMIN_PASSWORD;
const grafanaAdminPassword = grafanaPasswordFromEnv
    ? pulumi.secret(grafanaPasswordFromEnv)
    : (config.getSecret("grafanaAdminPassword") ?? pulumi.secret("changeme"));

const prometheusCommunityRepo = "https://prometheus-community.github.io/helm-charts";
const kubePromStackVersion = envString("KUBE_PROM_STACK_VERSION", "61.7.2");
const blackboxExporterVersion = envString("BLACKBOX_EXPORTER_VERSION", "8.17.0");
/** Matches prometheus-operator ~0.75.x shipped with kube-prometheus-stack 61.7.x (see chart appVersion). */
const prometheusOperatorCrdsVersion = envString("PROMETHEUS_OPERATOR_CRDS_VERSION", "13.0.0");

/**
 * Helm release name for kube-prometheus-stack (prefix for many cluster-scoped objects).
 * Default avoids collisions with legacy Pulumi `Chart` installs that used release name `kps`.
 */
const kubePromHelmReleaseName = envString("KUBE_PROM_HELM_RELEASE_NAME", "gbmkps");

/**
 * Grafana subchart `fullnameOverride` (Service / ClusterRole names include this string).
 * Default avoids collisions with legacy `guestbook-grafana-*` ClusterRoles from older revisions.
 */
const grafanaHelmFullname = envString("GRAFANA_HELM_FULLNAME", "gbmon-grafana");

/** Resolve kubeconfig file path (explicit env / Pulumi config / KUBECONFIG / default). */
function resolveKubeconfigPath(): string {
    const tried: string[] = [];
    const pushCandidate = (p: string | undefined) => {
        if (!p) return;
        const abs = path.resolve(p);
        if (!tried.includes(abs)) tried.push(abs);
    };
    pushCandidate(process.env.KUBECONFIG_PATH?.trim());
    pushCandidate(config.get("kubeconfigPath")?.trim());
    const kubeEnv = process.env.KUBECONFIG?.trim();
    if (kubeEnv) {
        pushCandidate(kubeEnv.split(path.delimiter)[0]?.trim());
    }
    pushCandidate(path.join(os.homedir(), ".kube", "config"));
    for (const p of tried) {
        try {
            const st = fs.statSync(p);
            if (st.isFile() && st.size > 0) {
                return p;
            }
        } catch {
            /* continue */
        }
    }
    throw new pulumi.RunError(
        "No kubeconfig file found or file is empty. Fix one of:\n" +
            "  • export KUBECONFIG=/path/to/kubeconfig\n" +
            "  • add KUBECONFIG_PATH=/path/to/kubeconfig to .env\n" +
            "  • pulumi config set kubeconfigPath /path/to/kubeconfig\n" +
            "  • ensure ~/.kube/config exists (e.g. minikube: minikube update-context; kind: kind export kubeconfig)\n" +
            `Tried: ${tried.join(", ") || "(none)"}`,
    );
}

const clusterProvider = new k8s.Provider("cluster", {
    kubeconfig: fs.readFileSync(resolveKubeconfigPath(), "utf8"),
});

function kopts(extra?: pulumi.CustomResourceOptions): pulumi.CustomResourceOptions {
    return extra ? { ...extra, provider: clusterProvider } : { provider: clusterProvider };
}

const monitoringNamespace = new k8s.core.v1.Namespace(
    "monitoring",
    {
        metadata: { name: "monitoring" },
    },
    kopts(),
);

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
    kopts({ dependsOn: [monitoringNamespace] }),
);

const blackboxAddress = "blackbox-exporter.monitoring.svc.cluster.local:9115";

// Use Helm Release (not Chart) so the Helm engine installs CRDs before CRs — fixes
// "no matches for kind ServiceMonitor / PrometheusRule" when Pulumi Chart parallelizes YAML applies.
const prometheusOperatorCrdsRelease = new k8s.helm.v3.Release(
    "prometheus-operator-crds",
    {
        name: "prometheus-operator-crds",
        chart: "prometheus-operator-crds",
        version: prometheusOperatorCrdsVersion,
        namespace: monitoringNamespace.metadata.name,
        repositoryOpts: { repo: prometheusCommunityRepo },
        timeout: 600,
    },
    kopts({ dependsOn: [monitoringNamespace] }),
);

const kpsRelease = new k8s.helm.v3.Release(
    "kps",
    {
        name: kubePromHelmReleaseName,
        chart: "kube-prometheus-stack",
        version: kubePromStackVersion,
        namespace: monitoringNamespace.metadata.name,
        repositoryOpts: { repo: prometheusCommunityRepo },
        // CRDs come from prometheus-operator-crds release; skip any duplicate CRDs in this chart package.
        skipCrds: true,
        timeout: 1200,
        values: {
            crds: {
                enabled: false,
            },
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
                fullnameOverride: grafanaHelmFullname,
                adminUser: "admin",
                adminPassword: grafanaAdminPassword,
                service: isMinikube
                    ? { type: "NodePort", nodePort: grafanaServiceNodePort }
                    : { type: "LoadBalancer" },
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
    kopts({ dependsOn: [monitoringNamespace, blackboxExporter, prometheusOperatorCrdsRelease] }),
);

//
// Guestbook (same topology as kubernetes-ts-guestbook/simple)
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment(
    "redis-leader",
    {
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
},
    kopts(),
);

const redisLeaderService = new k8s.core.v1.Service(
    "redis-leader",
    {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
},
    kopts(),
);

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment(
    "redis-replica",
    {
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
},
    kopts(),
);

const redisReplicaService = new k8s.core.v1.Service(
    "redis-replica",
    {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [{ port: 6379, targetPort: 6379 }],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
},
    kopts(),
);

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment(
    "frontend",
    {
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
},
    kopts(),
);

const frontendService = new k8s.core.v1.Service(
    "frontend",
    {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [{ port: 80 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
},
    kopts(),
);

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
    kopts({ dependsOn: [redisLeaderService] }),
);

const redisLeaderExporterService = new k8s.core.v1.Service(
    "redis-leader-exporter",
    {
    metadata: {
        name: "redis-leader-exporter",
        labels: redisLeaderExporterLabels,
    },
    spec: {
        ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        selector: redisLeaderExporterLabels,
    },
},
    kopts(),
);

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
    kopts({ dependsOn: [redisReplicaService] }),
);

const redisReplicaExporterService = new k8s.core.v1.Service(
    "redis-replica-exporter",
    {
    metadata: {
        name: "redis-replica-exporter",
        labels: redisReplicaExporterLabels,
    },
    spec: {
        ports: [{ name: "metrics", port: 9121, targetPort: 9121 }],
        selector: redisReplicaExporterLabels,
    },
},
    kopts(),
);

const smOpts: pulumi.CustomResourceOptions = kopts({
    dependsOn: [kpsRelease, redisLeaderExporterService],
});

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
    kopts({ dependsOn: [kpsRelease, redisReplicaExporterService] }),
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
    kopts({ dependsOn: [kpsRelease] }),
);

export const frontendIp: pulumi.Output<string> = isMinikube
    ? frontendService.spec.clusterIP
    : frontendService.status.loadBalancer.ingress.apply((ing) =>
          ing?.[0]?.ip ?? ing?.[0]?.hostname ?? "pending",
      );

export const grafanaAdminUser = "admin";
export const grafanaAdminPasswordOut = grafanaAdminPassword;

/** Minikube: fixed NodePort from Helm values (see GRAFANA_NODE_PORT). Cloud: resolve LB host with kubectl after deploy. */
export const grafanaUrl = isMinikube
    ? pulumi.output(
          `http://127.0.0.1:${grafanaServiceNodePort} (or run: minikube service ${grafanaHelmFullname} -n monitoring --url)`,
      )
    : pulumi.output(
          `LoadBalancer: kubectl get svc ${grafanaHelmFullname} -n monitoring -o wide — open http://<EXTERNAL-IP> when ADDRESS is assigned.`,
      );

export const verifyMetricsHint =
    "kubectl -n monitoring port-forward svc/prometheus-operated 9090:9090 (or kubectl get svc -n monitoring | grep -i prom). Prometheus UI → Status → Targets: look for redis-leader-exporter, redis-replica-exporter, blackbox-frontend. PromQL: redis_connected_clients, probe_success{job=\"blackbox-frontend\"}";
