#!/usr/bin/env bash
# Shared by add-cadvisor.sh and add-prometheus.sh: lets only the Board Remote PCs reach a monitoring port.
# cAdvisor and Prometheus have no sign in, so the port is closed to everyone else on the network.
# Docker publishes ports past ufw and firewalld, so the rule goes in Docker's own DOCKER-USER chain,
# matched on the host port, and leaves traffic between containers alone.
# --allow 10.4.2.15,10.4.2.16   only those addresses (the Board Remote PCs)
# --open                         no rule: anyone on the network can reach the port
check_allow() {
  if [ -z "$ALLOW" ] && [ "$OPEN" != 1 ]; then
    fail "Say which Board Remote PCs may read this port: --allow <PC address>[,<PC address>]. (--open leaves it reachable from the whole network.)"
  fi
  for ip in ${ALLOW//,/ }; do echo "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$' || fail "--allow takes IPv4 addresses, for example 10.4.2.15: $ip"; done
}
lock_port() {
  local port="$1" tag="hci-monitoring-$1"
  if [ "$OPEN" = 1 ]; then say "Port $port is open to the whole network (--open)."; return 0; fi
  command -v iptables >/dev/null || { say "iptables is not here: allow port $port only from $ALLOW in this server's firewall."; return 0; }
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || { say "Docker's DOCKER-USER chain is not here: allow port $port only from $ALLOW in this server's firewall."; return 0; }
  # drop this port's earlier rules, so running it again replaces them
  iptables -S DOCKER-USER | grep -F -- "--comment $tag" | sed 's/^-A /-D /' | while read -r rule; do eval iptables "$rule"; done
  iptables -I DOCKER-USER -p tcp -m conntrack --ctorigdstport "$port" -m comment --comment "$tag" -j DROP
  for ip in ${ALLOW//,/ }; do iptables -I DOCKER-USER -s "$ip" -p tcp -m conntrack --ctorigdstport "$port" -m comment --comment "$tag" -j ACCEPT; done
  # containers on this host (Prometheus reading cAdvisor) are not stopped by it
  iptables -I DOCKER-USER -i docker0 -m comment --comment "$tag" -j RETURN
  iptables -I DOCKER-USER -i br+ -m comment --comment "$tag" -j RETURN
  say "Port $port answers only $ALLOW (and this server's own containers)."
  say "These firewall rules last until the server restarts. Run this script again after a restart, or save them (iptables-persistent / netfilter-persistent save)."
}
