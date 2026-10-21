HCI ONE REMOTE RELAY  0.1  (proof of concept)
The stand in for the HCI cloud. Each hospital's Board Remote dials out to it,
and you sign in to its web viewer from a phone or PC to see every site.

HCI HOSTED: https://remote.hci-tv.com
The relay runs on an HCI server in Azure (resource group hci-remote, server
hci-remote-relay, East US 2). Caddy gives it a real certificate and renews it
by itself; only ports 80 and 443 are open. Board Remote already fills in
remote.hci-tv.com as the relay address. First admin password, from Azure
Cloud Shell:
  az vm run-command invoke -g hci-remote -n hci-remote-relay
    --command-id RunShellScript --scripts "cat /opt/hci-remote/FIRST_SIGN_IN.txt"
Sign in, add yourself under Admin, change the admin password, then delete that
file the same way (rm instead of cat).
Update the relay: copy relay.js, viewer.html, ws.js to /opt/hci-remote on the
server and restart the hci-remote service. A new server: deploy/install.sh
does everything (as root on Ubuntu 22.04 or 24.04: bash install.sh
remote.hci-tv.com), then point the address at the server in GoDaddy DNS.

TRY IT ON ONE PC (about 5 minutes)
1. Double click RELAY.bat. A browser opens the viewer. Sign in as admin with
   the password in FIRST_SIGN_IN.txt. Under Admin, add yourself, then delete
   that file. Change the admin password from the account menu.
2. Admin, Connect a hospital: type the site name and click Make code.
3. In Board Remote, click Remote (bottom right of Boards). Relay address
   localhost:8780, then the code. Connecting is the consent: HCI gets health,
   fixes and live view, and nobody at the site is asked again.
4. Back in the viewer: the site, its boards, fixes, and live view with touch.

ON YOUR PHONE (relay on your own PC)
Same WiFi: http://<this PC's address>:8780 (allow Node through the Windows
firewall when asked). Anywhere: run SHARE.bat while RELAY.bat is running. It
prints a temporary https link through Cloudflare. The link changes each time.
Live video needs Safari 16.4 or newer on iPhone, or Chrome or Edge. Older
browsers get a picture every few seconds.

WHAT IT PROVES
Nothing is opened at the hospital: Board Remote dials out. Consent comes once,
when the site is connected; after that HCI goes straight in, and the link
stays on until HCI removes the site under Admin. The site sees a bar while HCI
views a board and keeps a log. The relay logs every sign in and action under
Admin, Activity.

NOT YET, BEFORE REAL PATIENT SITES
Only demo boards until these exist: Microsoft single sign on with multifactor,
video encrypted end to end (today the relay can see it), per site access by
role, and a security review. See the HCI ONE Remote plan.

FILES
relay.js  viewer.html  ws.js    the relay and its web viewer
relay.json                      users (hashed passwords), sites, codes, log.
                                Keep it private.
RELAY.bat  SHARE.bat  share.ps1  start the relay, make a phone link
deploy/install.sh               set up the relay on an Ubuntu server with HTTPS
