; HCI ONE Board Remote, Windows installer (Inno Setup 6).
; Built by .github/workflows/windows.yml, which stages build\win first:
;   node\node.exe                  Node (x64, LTS)
;   service\                       supervisor.js, release-key.pub, BoardRemoteService.exe (WinSW) and .xml
;   versions\{#AppVersion}\        this Board Remote version, from the signed package
;   bundled\scrcpy\                scrcpy and adb, copied to the data folder if it has none
;   setup-data.ps1, open-board-remote.vbs, board_remote.ico
; iscc /DAppVersion=2.1.0 /DStage=..\build\win installer\BoardRemote.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Stage
  #define Stage "..\build\win"
#endif

[Setup]
AppId={{2E841E67-821E-47E6-82A7-65333F7CA707}
AppName=HCI ONE Board Remote
AppVersion={#AppVersion}
AppVerName=HCI ONE Board Remote {#AppVersion}
AppPublisher=HCI ONE
AppPublisherURL=https://hci-tv.com
AppSupportURL=https://hci-tv.com
AppContact=513 271 8100
DefaultDirName={commonpf64}\HCI ONE\Board Remote
DisableDirPage=yes
DefaultGroupName=HCI ONE
DisableProgramGroupPage=yes
OutputBaseFilename=HCI-ONE-Board-Remote-Setup-{#AppVersion}
OutputDir=..\dist
SetupIconFile={#Stage}\board_remote.ico
UninstallDisplayIcon={app}\board_remote.ico
Compression=lzma2/max
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
WizardStyle=modern
CloseApplications=no
; signed later: the workflow signs this exe when a code signing certificate is configured

[Files]
Source: "{#Stage}\node\*"; DestDir: "{app}\node"; Flags: ignoreversion recursesubdirs
Source: "{#Stage}\service\*"; DestDir: "{app}\service"; Flags: ignoreversion recursesubdirs
Source: "{#Stage}\versions\{#AppVersion}\*"; DestDir: "{app}\versions\{#AppVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\bundled\*"; DestDir: "{app}\bundled"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#Stage}\setup-data.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\open-board-remote.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Stage}\board_remote.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\HCI ONE\Board Remote"

[Icons]
Name: "{commonprograms}\HCI ONE Board Remote"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-board-remote.vbs"""; IconFilename: "{app}\board_remote.ico"
Name: "{commondesktop}\Board Remote"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-board-remote.vbs"""; IconFilename: "{app}\board_remote.ico"

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\setup-data.ps1"" -Data ""{commonappdata}\HCI ONE\Board Remote"" -App ""{app}"""; StatusMsg: "Bringing over boards and settings..."; Flags: runhidden waituntilterminated
Filename: "{app}\service\BoardRemoteService.exe"; Parameters: "install"; StatusMsg: "Setting up the Board Remote service..."; Flags: runhidden waituntilterminated; Check: not ServiceExists
Filename: "{app}\service\BoardRemoteService.exe"; Parameters: "start"; StatusMsg: "Starting Board Remote..."; Flags: runhidden waituntilterminated
Filename: "{sys}\wscript.exe"; Parameters: """{app}\open-board-remote.vbs"""; Description: "Open Board Remote"; Flags: postinstall nowait skipifsilent

[UninstallRun]
Filename: "{app}\service\BoardRemoteService.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "StopSvc"
Filename: "{app}\service\BoardRemoteService.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "DelSvc"

[UninstallDelete]
; versions the service downloaded itself; the data folder (boards, health, audit) is kept
Type: filesandordirs; Name: "{app}\versions"

[Messages]
FinishedLabel=Board Remote is installed and running as a Windows service. It starts with Windows, restarts itself if it stops, and installs updates from HCI ONE Cloud overnight. Your boards and settings are in C:\ProgramData\HCI ONE\Board Remote.

[Code]
function ServiceExists: Boolean;
var Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query HCIOneBoardRemote', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

// Running the installer again (a newer version by hand): stop the service first so files are free.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  Result := '';
  if ServiceExists then
    Exec(ExpandConstant('{sys}\sc.exe'), 'stop HCIOneBoardRemote', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(3000);
end;
