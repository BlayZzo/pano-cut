; Zusätzliche Texte für den Windows-Installer (NSIS) von PanoCut.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Willkommen bei PanoCut"
  !define MUI_WELCOMEPAGE_TEXT "Dieser Assistent installiert PanoCut auf deinem Computer.$\r$\n$\r$\nPanoCut ist dein Schnittprogramm für 360°-, Kamera- und Drohnenvideos.$\r$\n$\r$\nKlicke auf Weiter, um fortzufahren."
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "PanoCut deinstallieren"
  !define MUI_WELCOMEPAGE_TEXT "Dieser Assistent entfernt PanoCut vollständig von deinem Computer – inklusive Programmdateien, Vorschau-Cache und Einstellungen.$\r$\n$\r$\nDeine Videos und Projektdateien bleiben erhalten."
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

!macro customUnInstall
  ; Vorschau-Cache und Einstellungen vollständig entfernen
  RMDir /r "$LOCALAPPDATA\PanoCut"
  RMDir /r "$APPDATA\PanoCut"
!macroend
