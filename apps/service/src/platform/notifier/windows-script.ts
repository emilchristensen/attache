/**
 * The Windows PowerShell script behind Windows notifications (toasts),
 * through the Windows Runtime's ToastNotificationManager.
 *
 * Windows shows toasts only from a sender it knows, so Jarvis registers its
 * own app id with the name people see, under
 * `HKCU\Software\Classes\AppUserModelId\<app>`, the registration Windows
 * accepts from apps without an installer package. The text is added as text
 * nodes, so markup in a title or body is shown as typed.
 *
 * Requests (`op`): `check` registers the sender and answers whether Windows
 * lets it show notifications (`enabled`, and `setting` when not); `show`
 * also shows one with `title` and `body`; `forget` removes the registration.
 */
export const TOAST_SCRIPT = String.raw`
function Invoke-Request($req) {
  $key = 'HKCU:\Software\Classes\AppUserModelId\' + [string]$req.app
  if ([string]$req.op -eq 'forget') {
    if (Test-Path -LiteralPath $key) { Remove-Item -LiteralPath $key -Recurse -Force }
    return @{ ok = $true }
  }
  if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }
  $null = New-ItemProperty -LiteralPath $key -Name DisplayName -Value ([string]$req.name) -PropertyType String -Force

  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.UI.Notifications.NotificationSetting, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$req.app)
  # Where Windows cannot say (no setting comes back), the notification is handed over all the same.
  $setting = $notifier.Setting
  if ($null -ne $setting -and [string]$setting -ne 'Enabled') { return @{ ok = $true; enabled = $false; setting = [string]$setting } }
  if ([string]$req.op -ne 'show') { return @{ ok = $true; enabled = $true } }

  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text/><text/></binding></visual></toast>')
  $texts = $xml.GetElementsByTagName('text')
  $null = $texts.Item(0).AppendChild($xml.CreateTextNode([string]$req.title))
  $null = $texts.Item(1).AppendChild($xml.CreateTextNode([string]$req.body))
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $toast.Group = 'jarvis'
  $notifier.Show($toast)
  return @{ ok = $true; enabled = $true }
}
`;
