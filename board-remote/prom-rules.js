'use strict';
/* HCI's alert rules for a hospital backend (MediaCare and its Spring Boot services, Kong), run
   read-only against the site's own Prometheus once a minute by containers.js. Nothing is changed on
   the site's Prometheus. Each query returns the services breaking the rule right now (one series per
   Prometheus job); a rule fires once a service has broken it for `for` minutes in a row and clears as
   soon as it stops. Only the rule, the job name and the number go to HCI ONE Cloud.
   Checked against the metrics the MediaCare stack exposes (Micrometer: http_server_requests_*,
   jvm_*, hikaricp_*, logback_events_total; Kong: kong_*). A rule whose metrics a site lacks returns
   nothing and never fires. */
const pct = v => (v * 100 >= 10 ? Math.round(v * 100) : (v * 100).toFixed(1)) + '%';
const HTTP = 'http_server_requests_seconds';
const busy = `sum by (job) (rate(${HTTP}_count[5m])) > 0.05`;   // at least 3 requests a minute

module.exports = [
  { id: 'service_down', for: 2, q: 'up == 0',
    title: j => j + ' is down: Prometheus cannot reach it' },
  { id: 'error_rate', for: 5, q: `(sum by (job) (rate(${HTTP}_count{status=~"5.."}[5m])) / sum by (job) (rate(${HTTP}_count[5m]))) > 0.05 and ${busy}`,
    title: (j, v) => j + ' fails ' + pct(v) + ' of its requests (5xx)' },
  { id: 'slow', for: 10, q: `(sum by (job) (rate(${HTTP}_sum[5m])) / sum by (job) (rate(${HTTP}_count[5m]))) > 2 and ${busy}`,
    title: (j, v) => j + ' answers slowly: ' + v.toFixed(1) + ' s on average' },
  { id: 'java_memory', for: 10, q: 'max by (job) (jvm_memory_used_bytes{area="heap",id=~".*(Old Gen|Tenured).*"} / jvm_memory_max_bytes{area="heap",id=~".*(Old Gen|Tenured).*"} > 0) > 0.9',
    title: (j, v) => j + ' is running out of Java memory (' + pct(v) + ' of its heap)' },
  { id: 'gc', for: 10, q: 'sum by (job) (rate(jvm_gc_pause_seconds_sum[5m])) > 0.1',
    title: (j, v) => j + ' spends ' + pct(v) + ' of its time in garbage collection' },
  { id: 'db_pool', for: 5, q: 'max by (job) (hikaricp_connections_pending) > 0',
    title: (j, v) => j + ' is waiting for database connections (' + Math.round(v) + ' waiting)' },
  { id: 'error_logs', for: 10, q: 'sum by (job) (rate(logback_events_total{level="error"}[5m])) * 60 > 10 and sum by (job) (rate(logback_events_total{level="error"}[5m])) > 3 * (sum by (job) (rate(logback_events_total{level="error"}[5m] offset 1w)) + 0.001)',
    title: (j, v) => j + ' logs ' + Math.round(v) + ' errors a minute, far more than a week ago' },
  { id: 'kong_errors', for: 5, job: 'kong-gateway', q: '(sum(rate(kong_http_requests_total{code=~"5.."}[5m])) / sum(rate(kong_http_requests_total[5m]))) > 0.05 and sum(rate(kong_http_requests_total[5m])) > 0.05',
    title: (j, v) => 'Kong gateway: ' + pct(v) + ' of requests fail (5xx)' },
  { id: 'kong_db', for: 1, q: 'kong_datastore_reachable == 0',
    title: () => 'Kong gateway cannot reach its database' }
];
