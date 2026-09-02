@echo off
title ¶¨¸åAI - ÄÚÍø´©Í¸£¨cpolar£©
cd /d "%~dp0"
echo Æô¶¯ÄÚÍø´©Í¸£º°Ñ 8788 ¶Ë¿ÚÓ³Éäµ½¹«Íø...
echo Ê×´ÎÊ¹ÓÃĞèÏÈ×¢²á cpolar ÕËºÅ²¢Ö´ĞĞÒ»´Î authtoken£¨¼ûÏÂ·½ÍøÖ·£©
echo ×¢²á: https://dashboard.cpolar.com/signup   Token: https://dashboard.cpolar.com/auth
:loop
C:\Users\<ç”¨æˆ·å>\cpolar\bin\cpolar\cpolar.exe http 8788 >> logs\cpolar.log 2>&1
echo [¿´ÃÅ¹·] %date% %time% ´©Í¸ÍË³ö£¬3 Ãëºó×Ô¶¯ÖØÆô£¨¹Ø±Õ±¾´°¿Ú¼´Í£Ö¹´©Í¸£©
echo [¿´ÃÅ¹·] %date% %time% ´©Í¸ÍË³ö >> logs\cpolar.log
timeout /t 3 /nobreak >nul
goto loop