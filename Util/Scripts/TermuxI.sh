#!/data/data/com.termux/files/usr/bin/bash
set -e

echo "Concede el Permiso para Evitar que el sistema Cierre la App"
sleep 5 
termux-wake-lock

echo "Concede permiso al almacenamiento"
sleep 5
printf 'y\y' | termux-setup-storage

echo "Actualizando, Tardara unos Minutos"
pkg install -y tur-repo x11-repo
apt-get update
apt update -y && yes | apt upgrade && pkg install -y proot-distro git wget termux-services termux-api msedit




proot-distro install archlinux

cat > ~/.bashrc <<'EOF'
termux-wake-lock

mkdir -p /sdcard/Download/aMule
ln -sfn /sdcard/Download/aMule repo/MuLy/Archivos

R='\033[0;31m'
G='\033[0;32m'
Y='\033[1;33m'
N='\033[0m'

echo -e "${Y}⌨️Presiona una tecla para cancelar${N}"
echo -e "${Y}⌨️Press any key to cancel${N}"

t=5
c=0

while [ $t -gt 0 ]; do
    echo -ne "${Y}Iniciando en $t... / Starting in $t...\r${N}"
    if read -rsn1 -t 1 k; then
        c=1
        break
    fi
    t=$((t-1))
done

if [ $c -eq 1 ]; then
echo
echo -e "${R}Inicio cancelado / Autostart canceled${N}"
echo -e "${G}Puedes usar Termux normalmente / You can use Termux normally${N}"
echo -e "Bot en contenedor / Bot in container: ${Y}proot-distro login archlinux${N}"

echo -e "Ir a carpeta / Go folder: ${Y}cd aMuleD.bin{N}"
echo -e "${G}Ayuda / Help: https://github.com/weskerty/aMuleD.bin/discussions/categories/q-a${N}"
return
fi

echo
echo -e "${G}Iniciando aMuleD / Starting aMuleD${N}"

proot-distro login archlinux -- bash -c 'cd repo 2>/dev/null || true && chmod +x START.sh && (sleep 20 && /data/data/com.termux/files/usr/bin/termux-open http://localhost:6859) && ./START.sh'

EOF

proot-distro login archlinux -- bash -c '
set -e

pacman -Syu --noconfirm
pacman -S git wget ffmpeg nodejs nano python3 --noconfirm

echo "[D] Repo MuLy"
rm -rf aMuleD.bin
git clone https://github.com/weskerty/aMuleD.bin.git repo

echo "[D] "

mkdir -p /sdcard/Download/aMule

echo "[D] Descargas estaran en tu Carpeta Descargas."
ln -sfn /sdcard/Download/aMule repo/MuLy/Archivos

echo "[D] Actualizando"
cd repo
cp -r .aMule ~/.aMule
chmod +x START.sh
./START.sh &
sleep 20
echo "[D] Iniciando" 
 /data/data/com.termux/files/usr/bin/termux-open "localhost:6859"
'

