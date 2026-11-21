param([string]$ReadyPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class OrbFixtureNative {
 [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr window,int id,uint modifiers,uint key);
 [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr window,int id);
}
'@
$form=[System.Windows.Forms.Form]::new();$form.Text='Desktop entry external-process fixture';$form.Width=1200;$form.Height=760;$form.StartPosition='Manual';$form.Left=100;$form.Top=100
$label=[System.Windows.Forms.Label]::new();$label.Text='Windows fixture: verifies foreground and topmost without reading user content.';$label.AutoSize=$true;$label.Left=32;$label.Top=40;$form.Controls.Add($label)
$form.Add_Shown({
 $form.Activate();$held=[OrbFixtureNative]::RegisterHotKey($form.Handle,1,3,0x7a)
 @{handle=$form.Handle.ToInt64();pid=$PID;heldShortcut=$held}|ConvertTo-Json -Compress|Set-Content -LiteralPath $ReadyPath -Encoding utf8
})
$timer=[System.Windows.Forms.Timer]::new();$timer.Interval=90000;$timer.Add_Tick({$form.Close()});$timer.Start()
try{[System.Windows.Forms.Application]::Run($form)}finally{[void][OrbFixtureNative]::UnregisterHotKey($form.Handle,1);$timer.Dispose();$form.Dispose()}
