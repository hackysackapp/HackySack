!macro NSIS_HOOK_PREINSTALL
  ; Automatically enable Desktop Application Microphone Permission in Windows Privacy Settings
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone" "Value" "Allow"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged" "Value" "Allow"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Pre-uninstall hook
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Execute silent credential wipe asynchronously without delaying uninstaller UI
  Exec 'cmd.exe /c "taskkill /F /IM hackysack.exe /T >nul 2>&1 & cmdkey /delete:cloud_jwt.com.hackysack.app >nul 2>&1 & cmdkey /delete:cloud_mode.com.hackysack.app >nul 2>&1 & cmdkey /delete:ai_api_key.com.hackysack.app >nul 2>&1 & cmdkey /delete:transcription_api_key.com.hackysack.app >nul 2>&1 & cmdkey /delete:cloud_endpoint.com.hackysack.app >nul 2>&1 & cmdkey /delete:groq_api_key.com.hackysack.app >nul 2>&1 & cmdkey /delete:openai_api_key.com.hackysack.app >nul 2>&1"'
  ; Recursively remove app data directories using fast native NSIS commands
  RMDir /r "$APPDATA\HackySack"
  RMDir /r "$LOCALAPPDATA\HackySack"
  RMDir /r "$LOCALAPPDATA\com.hackysack.app"
  RMDir /r "$APPDATA\com.hackysack.app"
  RMDir /r "$LOCALAPPDATA\hackysack"
  RMDir /r "$APPDATA\hackysack"
!macroend
