HCI ONE BOARD REMOTE  2.1
One click ADB to every board, live screens, Device Health and Deploy.
New in 2.1: a Windows installer. Board Remote runs as a Windows service, starts
with Windows, restarts itself, and installs signed updates from HCI ONE Cloud
overnight (or when approved), rolling back on its own if a version fails to
start. Run HCI-ONE-Board-Remote-Setup.exe; it brings over an earlier folder
install's boards and settings. Data: C:\ProgramData\HCI ONE\Board Remote.

New in 2.0: HCI ONE Cloud (optional). Join this PC on the Remote view with a
code from the web dashboard. Boards, rooms and health then show in one web
view with every other Board Remote PC at the hospital; rooms sync both ways
and HCI can lock locations. Screens and logs never leave this PC.

In 1.9: the Audit view. Every morning it records which boards dropped
overnight, saves a snapshot of every room screen, reads which fall risk and
contact tiles were showing, and compares that with the hospital's morning
list of rooms, room by room.

FIRST TIME (about 2 minutes)
1. Unzip somewhere permanent, for example C:\HCI\Board Remote. Double click
   SETUP.bat. Say Y to start with Windows so boards are watched all the time.
2. Add boards: Deploy, Import room list (paste rooms and IPs from Excel), or
   New devices, or Add board. The first connect asks on each board "Allow USB
   debugging?". Tick Always allow from this computer and tap Allow.
3. Click the gear on Device health: site name, Teams links for HCI Support
   and Hospital IT, an optional Claude API key, and the door sign LED command
   (preset for HCI ONE Room Sign). Send a test alert.

VIEWS (switch at the top)
Boards          Live screens in room order. Click one for live video with
                touch. Mirror, Shell, drop an APK on a card to install it.
                Big sites: find a room or IP, or show one unit or type.
                Snapshots saves a picture of every connected board to a
                folder, on demand or on a timer, so you can match what was
                on a board against the messages that came in. It has a
                gallery, the folder path and how long to keep them.
Device health   Heartbeat wall, where each board breaks, first read, Claude,
                console and fixes that check their own result. On the wall a
                room with more than one board shows a square per board; click
                a square to open that exact device. The console also has Log
                history (the board's logs kept here for up to 48 hours, with
                Camera, LED ring and Crash views, a time range, a level filter
                and search), Save snapshot, and, on door signs, LED bezel
                control: pick Solid or Flash, then a colour, to set the ring.
New devices     Anything answering ADB on 5555, cameras on 65037, or USB.
                Claim it in two taps.
                A device drops off this list as soon as it is added as a
                board, whether you claim it here or just type its IP on Boards.
Deploy          Room list import, app push and rooms in MediaCare (below).
Audit           The morning audit (below): overnight drops, a snapshot per
                room, and the screens compared with the hospital's list.
Remote          HCI ONE Remote, a proof of concept: HCI sees this site from
                anywhere, as far as you allow (REMOTE below).
Manual          The full manual, also offline: the Manual button in each
                view opens its section. Print or save it as a PDF there.

DEPLOY
Room list       Paste Room, Whiteboard IP, Door sign IP, Unit (any order, a
                header row helps) or simply "401, 10.20.4.11". Preview shows
                new, updated and skipped lines before anything changes.
Push an app     Drop the APK in the library. Pick Door signs or Whiteboards,
                Check versions, then Push. Each board shows its step and
                result: updated, already current, or why not (newer version
                on board, Android too old, storage full, different signing
                key with a Remove and install button, Allow pending, off).
Room signs      HCI ONE Room Sign is a standalone door sign (one big room
                number, no server, no patient data) and ships in the app
                library. Push it, then with it still picked click Set the
                room on each sign: every sign gets its room from the Boards
                page. No MediaCare needed. Long press a sign to set it by
                hand. Good for sites like this one that have no room feed.
Rooms in        MediaCare holds each device's room. Enter MediaCare's Kuzzle
MediaCare       address and a login that can change device records, then
                Find device records: it matches boards by MAC and picks the
                room field. Preview, Test on one, check that screen, Apply to
                the rest. The app restarts so it shows the room. Undo puts
                the old rooms back. Rooms CSV lists rooms, IPs, MACs, serials.
                Collections that look like patient or staff data are never
                read.

SITE SIZE (load tested with 154 simulated devices)
Heartbeat     each board about every 27 s, spread out: about 6 small checks a
              second for 150 boards, never more than 16 at once
Screens       only screens in view refresh: about 3 a second on Normal, 8 on
              Live, whatever the site size
Reconnects    16 at once at most; quiet for 2 min means a try every 30 s

AUDIT
Each morning (6:30 by default) every whiteboard and door sign with a room
gets a snapshot, and its screen is read for a fall risk or contact tile.
Only yes or no is kept, never the words on screen. The hospital's list of
rooms that should show fall risk or contact is pasted, chosen as a file, or
dropped in audit\inbox. The report shows each room as matching, missing on
screen, on screen but not on the list, or could not check, with its snapshot
and overnight drops. Report CSV saves the day. A Teams summary goes to HCI
Support when a Teams link is set. Kept 90 days.

REMOTE (proof of concept, demo boards only)
Click Remote at the bottom of Boards. Enter the relay address HCI gives you
and the code from HCI. This PC dials out over https (443); nothing here is
opened to the internet. Connecting is the hospital's consent: HCI then has
health, fixes and live view on every board, nobody here is asked again, and
Remote stays on (also after a restart) until HCI disconnects the site. A
Remote tab stays in the navigation. A bar shows while HCI views a board, with
End. Every action is listed under Activity. The relay: relay\README.txt.

ALERTS (all thresholds change under the gear)
Missed heartbeats 90 s        owner the first read names, Teams + pop up
No acknowledgement 5 min      escalates to Hospital IT and HCI Support
3+ boards in one closet down  one grouped alert to Hospital IT, open until
                              the last board is back
Clock, app, crash, screen, storage problems: HCI Support
Fixed                         all clear to everyone who was told

ON EACH BOARD
USB debugging on and network ADB on 5555. Cameras only work on 65037; every
scan tries 5555 first, then 65037 for addresses that did not answer, and a
board saved on 5555 that stops answering is retried on 65037 and moved there.
Install the HCI ONE ADB keeper on everything, cameras included: keeper 1.1
holds 65037 on cameras and 5555 on everything else. Board Remote will not put
keeper 1.0 on a camera, because 1.0 only knows 5555. The keeper exists so
network ADB survives reboots: it is already in the Deploy app library (push
it to every board), and a claim installs it too. Use DHCP reservations.

IF SOMETHING IS OFF
Network ADB is off     board is on but 5555 refused: USB to WiFi, then keeper
No answer              power, cable or switch port at the board
Not found in MediaCare the device has not registered with MediaCare yet
Stop it                STOP.bat, or the link at the bottom of Boards

FILES
boards.json   boards and settings, including Teams links, the Claude key and
              the MediaCare login. Keep it private and back it up.
deploy.json   app library list, push history, room changes for undo
remote.json   what HCI did here through Remote
apks\library  APKs you added       health.json  heartbeat history and alerts
apks          ADB keeper           tools        adb, scrcpy     logs
snapshots     screen snapshots by day (change the folder in Snapshots)
logs\devices  each board's log history, kept for 48 hours (set in Settings)
audit         morning audits by day: snapshots, results, the hospital's list
              (room numbers only), and audit\inbox for dropping the list
Only this PC can open the dashboard (localhost:7755). Snapshots are pictures
of the board screen and the logs come from the board, so keep this PC and
these folders inside the hospital, the same as everything else here.
