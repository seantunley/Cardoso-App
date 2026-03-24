@echo off
set SERVICE_NAME=CardosoCigarettes

echo Stopping and removing service "%SERVICE_NAME%"...
nssm stop %SERVICE_NAME%
nssm remove %SERVICE_NAME% confirm
echo Done.
pause
