#!/usr/bin/env bash

# Скрипт для автоматического создания SSH-ключа, настройки ~/.ssh/config
# и привязки текущего Git-репозитория к GitHub.

set -e

# Цвета для вывода
GREEN='\030[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${CYAN}=== Автоматическая настройка SSH ключа для Git ===${NC}\n"

# 1. Запрос названия проекта
DEFAULT_PROJECT=$(basename "$PWD")
read -p "$(echo -e "${YELLOW}Введите название проекта [по умолчанию: ${DEFAULT_PROJECT}]: ${NC}")" PROJECT_NAME
PROJECT_NAME="${PROJECT_NAME:-$DEFAULT_PROJECT}"

if [ -z "$PROJECT_NAME" ]; then
    echo -e "${RED}Ошибка: название проекта не может быть пустым.${NC}"
    exit 1
fi

# Формирование имени хоста: замена всех точек на дефисы
HOST_ALIAS=$(echo "$PROJECT_NAME" | tr '.' '-')

# 2. Определение устройства
DEFAULT_DEVICE=$(hostname 2>/dev/null || uname -n)
read -p "$(echo -e "${YELLOW}Укажите марку/название устройства [по умолчанию: ${DEFAULT_DEVICE}]: ${NC}")" DEVICE_NAME
DEVICE_NAME="${DEVICE_NAME:-$DEFAULT_DEVICE}"

SSH_DIR="$HOME/.ssh"
SSH_CONFIG="$SSH_DIR/config"
KEY_FILE="$SSH_DIR/$HOST_ALIAS"

# 3. Проверка наличия такой строки / Хоста в ~/.ssh/config
if grep -qE "^[[:space:]]*Host[[:space:]]+.*[[:blank:]]*${HOST_ALIAS}([[:space:]]|$)" "$SSH_CONFIG"; then
    echo -e "${RED}Ошибка: Хост '$HOST_ALIAS' уже существует в $SSH_CONFIG!${NC}"
    echo -e "Проверьте ваш файл конфига или используйте другое имя проекта."
    exit 1
fi

# Проверка существующих файлов ключей
if [ -f "$KEY_FILE" ] || [ -f "$KEY_FILE.pub" ]; then
    echo -e "${RED}Ошибка: Файл ключа '$KEY_FILE' уже существует!${NC}"
    exit 1
fi

# 4. Генерация SSH-ключа
COMMENT="Ключ с устройства \"${DEVICE_NAME}\" от проекта \"${PROJECT_NAME}\""
echo -e "\n${GREEN}Генерация ed25519 SSH-ключа...${NC}"
echo -e "Комментарий: ${YELLOW}$COMMENT${NC}"

ssh-keygen -t ed25519 -C "$COMMENT" -f "$KEY_FILE" -N ""

# 5. Добавление хоста в ~/.ssh/config
echo -e "\n${GREEN}Добавление конфигурации в $SSH_CONFIG...${NC}"
cat <<EOT >> "$SSH_CONFIG"

Host $HOST_ALIAS
    HostName github.com
    User git
    IdentityFile ~/.ssh/$HOST_ALIAS
    IdentitiesOnly yes
EOT

chmod 600 "$SSH_CONFIG"
echo -e "${GREEN}Запись в SSH config успешно добавлена.${NC}"

# 6. Привязка текущего Git репозитория
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    CURRENT_REMOTE=$(git remote get-url origin 2>/dev/null || true)
    
    if [ -n "$CURRENT_REMOTE" ]; then
        # Извлекаем путь репозитория (например, user/repo.git)
        # Обрабатывает форматы https://github.com/user/repo.git, git@github.com:user/repo.git и т.д.
        REPO_PATH=$(echo "$CURRENT_REMOTE" | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#')
        NEW_REMOTE="git@${HOST_ALIAS}:${REPO_PATH}"
        
        git remote set-url origin "$NEW_REMOTE"
        echo -e "${GREEN}Git origin remote успешно обновлен на:${NC} ${YELLOW}$NEW_REMOTE${NC}"
    else
        echo -e "${YELLOW}Предупреждение: Remote 'origin' не найден в этом репозитории.${NC}"
        read -p "Введите путь репозитория GitHub (например, username/repo.git) для установки origin (или нажмите Enter чтобы пропустить): " REPO_INPUT
        if [ -n "$REPO_INPUT" ]; then
            git remote add origin "git@${HOST_ALIAS}:${REPO_INPUT}"
            echo -e "${GREEN}Git origin установлен:${NC} ${YELLOW}git@${HOST_ALIAS}:${REPO_INPUT}${NC}"
        fi
    fi
else
    echo -e "${YELLOW}Текущая папка не является Git-репозиторием. Remote URL не изменен.${NC}"
fi

# 7. Вывод публичного ключа и инструкция
echo -e "\n========================================================"
echo -e "${GREEN}ГОТОВО! Публичный ключ для добавления в GitHub:${NC}"
echo -e "========================================================\n"

cat "${KEY_FILE}.pub"

echo -e "\n========================================================"
echo -e "${YELLOW}Скопируйте этот публичный ключ выше и вставьте его на GitHub:${NC}"
echo -e "1. Для личного аккаунта: ${CYAN}https://github.com/settings/ssh/new${NC}"
echo -e "2. Или в настройки конкретного репозитория: ${CYAN}Settings -> Deploy keys -> Add deploy key${NC} (отметьте 'Allow write access')"
echo -e "========================================================\n"
