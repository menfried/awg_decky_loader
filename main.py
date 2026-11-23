import asyncio
import errno
import hashlib
import os
import pwd
import re
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path


STATE = Path("/var/lib/decky-amneziawg")
BIN = STATE / "bin"
BUNDLED_TOOLS = Path(__file__).resolve().parent / "runtime"
TOOLS = ("awg", "awg-quick", "amneziawg-go")
PROFILES = STATE / "profiles"
LIMIT = 128 * 1024
PROFILE_ID = re.compile(r"awg[a-f0-9]{12}")
BLOCKED = {"preup", "postup", "predown", "postdown", "saveconfig"}
SYSTEM_PATH = "/usr/bin:/usr/sbin"


def system_error(exc):
    code = errno.errorcode.get(exc.errno, "OSERROR")
    return f"{exc.strerror or 'Системная ошибка'} ({code})"


def normalize_config(raw):
    try:
        config = raw.decode("utf-8-sig").replace("\r\n", "\n")
    except UnicodeError:
        raise ValueError("Файл .conf должен быть в UTF-8.") from None
    section = None
    sections = []
    lines = []
    required = set()
    for row in config.split("\n"):
        line = row.partition("#")[0].strip(" \t")
        if not line:
            continue
        if re.search(r"[^\x20-\x7e\t]", line):
            raise ValueError("В конфиге есть недопустимые символы.")
        if line.lower() in {"[interface]", "[peer]"}:
            section = line.lower()
            sections.append(section)
            lines.append("[Interface]" if section == "[interface]" else "[Peer]")
            continue
        key, delimiter, value = line.partition("=")
        key, value = key.strip(), value.strip()
        lower = key.lower()
        if not section or not delimiter or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", key) or not value:
            raise ValueError("Ожидается нативный конфиг AmneziaWG с секциями [Interface] и [Peer].")
        if lower in BLOCKED:
            raise ValueError("Удалите из конфига команды PreUp/PostUp/PreDown/PostDown и SaveConfig.")
        if section == "[interface]":
            patterns = {
                "address": r"[a-fA-F0-9:./, \t]+",
                "dns": r"[a-zA-Z0-9.:, \t-]+",
                "mtu": r"[0-9]+",
                "table": r"(?:auto|off|[0-9]+)",
                "fwmark": r"(?:off|[0-9]+|0x[0-9a-fA-F]+)",
            }
            if lower in patterns and not re.fullmatch(patterns[lower], value):
                raise ValueError(f"Некорректное значение поля {key}.")
        required.add((section, lower))
        lines.append(f"{key} = {value}")
    if sections[:2] != ["[interface]", "[peer]"] or sections.count("[interface]") != 1:
        raise ValueError("Ожидается одна секция [Interface] и хотя бы одна [Peer].")
    if not {("[interface]", "privatekey"), ("[interface]", "address"), ("[peer]", "publickey")} <= required:
        raise ValueError("В конфиге должны быть PrivateKey, Address и PublicKey.")
    return ("\n".join(lines) + "\n").encode()


def read_config(path):
    user = pwd.getpwnam(os.environ.get("DECKY_USER", "deck"))
    home = Path(user.pw_dir).resolve()
    source = Path(path)
    if source.suffix.lower() != ".conf" or not source.is_absolute():
        raise ValueError("Выберите файл .conf из домашней папки Steam Deck.")
    source = source.resolve(strict=True)
    if not source.is_relative_to(home):
        raise ValueError("Выберите файл .conf из домашней папки Steam Deck.")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    with os.fdopen(os.open(source, flags), "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != user.pw_uid:
            raise ValueError("Выберите обычный файл .conf, принадлежащий пользователю Steam Deck.")
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise ValueError("Размер файла .conf превышает 128 КиБ.")
    return normalize_config(raw)


def install_tools():
    checksums = {
        name: digest
        for digest, name in (line.split() for line in (BUNDLED_TOOLS / "SHA256SUMS").read_text().splitlines())
    }
    binaries = {name: (BUNDLED_TOOLS / name).read_bytes() for name in TOOLS}
    if any(hashlib.sha256(data).hexdigest() != checksums.get(name) for name, data in binaries.items()):
        raise ValueError("Проверка файлов AmneziaWG не прошла.")

    BIN.mkdir(mode=0o700, exist_ok=True)
    for name, data in binaries.items():
        target = BIN / name
        if target.is_file() and os.access(target, os.X_OK) and target.read_bytes() == data:
            continue
        stream = tempfile.NamedTemporaryFile(dir=BIN, delete=False)
        staging = Path(stream.name)
        try:
            with stream:
                stream.write(data)
            staging.chmod(0o755)
            staging.replace(target)
        finally:
            staging.unlink(missing_ok=True)

    resolver = BIN / "resolvconf"
    if os.access("/usr/bin/resolvconf", os.X_OK):
        resolver.unlink(missing_ok=True)
    elif os.access("/usr/bin/resolvectl", os.X_OK) and not resolver.is_symlink():
        resolver.symlink_to("/usr/bin/resolvectl")


def active(profile_id):
    return (Path("/sys/class/net") / profile_id).exists()


def traffic_sample(profile_id):
    stats = Path("/sys/class/net") / profile_id / "statistics"
    try:
        return {
            "id": profile_id,
            "time": time.monotonic(),
            "rx": int((stats / "rx_bytes").read_text()),
            "tx": int((stats / "tx_bytes").read_text()),
        }
    except (OSError, ValueError):
        return None


def handshake_age(profile_id):
    try:
        result = subprocess.run(
            [str(BIN / "awg"), "show", profile_id, "latest-handshakes"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=2,
            check=True,
        )
        stamps = [int(line.split()[-1]) for line in result.stdout.splitlines() if line.strip()]
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    latest = max(stamps, default=0)
    return max(0, int(time.time()) - latest) if latest else None


def run_quick(action, profile):
    try:
        result = subprocess.run(
            [str(BIN / "awg-quick"), action, str(profile)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            env={"PATH": f"{BIN}:{SYSTEM_PATH}", "HOME": "/root", "WG_ENDPOINT_RESOLUTION_RETRIES": "2"},
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise ValueError("AmneziaWG не ответил за 60 секунд. Проверьте состояние туннеля.") from None
    if result.returncode:
        # Upstream output can contain lines from the config, including credentials.
        if b"resolvconf" in result.stderr and b"not found" in result.stderr:
            raise ValueError("Для DNS из конфига нужен resolvconf в SteamOS.")
        raise ValueError("AmneziaWG не смог выполнить операцию. Проверьте конфиг и зависимости SteamOS.")


class Plugin:
    async def _main(self):
        self.lock = asyncio.Lock()
        self.ready = False

    def _snapshot(self):
        profiles = []
        for config in PROFILES.glob("*/*.conf"):
            profile_id = config.stem
            if config.parent.name == profile_id and PROFILE_ID.fullmatch(profile_id):
                label = config.with_suffix(".name")
                name = label.read_text(encoding="utf-8") if label.is_file() else profile_id
                profiles.append({"id": profile_id, "name": name, "active": active(profile_id)})
        current = next((item["id"] for item in profiles if item["active"]), None)
        return {
            "profiles": sorted(profiles, key=lambda item: item["name"].casefold()),
            "ready": self.ready,
            "traffic": traffic_sample(current) if current else None,
            "handshakeAge": handshake_age(current) if current and self.ready else None,
        }

    def _change(self, action, value):
        if action == "import":
            try:
                config = read_config(value)
            except FileNotFoundError:
                raise ValueError("Выбранный .conf не найден (ENOENT). Откройте папку загрузок и нажмите на сам файл.") from None
            except KeyError:
                raise ValueError("Не удалось определить домашнюю папку пользователя Decky.") from None
            except (OSError, RuntimeError) as exc:
                detail = system_error(exc) if isinstance(exc, OSError) else "проверьте путь к файлу"
                raise ValueError(f"Не удалось прочитать выбранный .conf: {detail}.") from None
            profile_id = "awg" + uuid.uuid4().hex[:12]
            folder = PROFILES / profile_id
            folder.mkdir(mode=0o700)
            profile = folder / f"{profile_id}.conf"
            try:
                profile.with_suffix(".name").write_text(Path(value).stem, encoding="utf-8")
                with os.fdopen(os.open(profile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                    stream.write(config)
            except OSError:
                profile.unlink(missing_ok=True)
                profile.with_suffix(".name").unlink(missing_ok=True)
                folder.rmdir()
                raise
            return

        if not PROFILE_ID.fullmatch(value):
            raise ValueError("Профиль не найден.")
        profile = PROFILES / value / f"{value}.conf"
        if not profile.is_file():
            raise ValueError("Профиль не найден.")
        if action == "delete":
            if active(value):
                raise ValueError("Сначала отключите туннель.")
            profile.unlink()
            profile.with_suffix(".name").unlink(missing_ok=True)
            profile.parent.rmdir()
            return
        if action == "up" and any(item["active"] and item["id"] != value for item in self._snapshot()["profiles"]):
            raise ValueError("Сначала отключите текущий туннель.")
        if active(value) == (action == "up"):
            return
        if not self.ready:
            raise ValueError("Сетевые инструменты AmneziaWG ещё не готовы.")
        run_quick(action, profile)

    async def manage(self, action, value=""):
        if action not in ("status", "import", "up", "down", "delete") or not isinstance(value, str):
            return {"error": "Недопустимая операция."}
        async with self.lock:
            error = ""
            phase = "Подготовка сетевых инструментов"
            try:
                if not self.ready:
                    if os.geteuid() != 0:
                        raise ValueError("Decky запустил плагин без прав root. Обновите Decky Loader и переустановите ZIP.")
                    STATE.mkdir(mode=0o700, exist_ok=True)
                    PROFILES.mkdir(mode=0o700, exist_ok=True)
                    await asyncio.to_thread(install_tools)
                    self.ready = True
                if action != "status":
                    phase = {
                        "import": "Сохранение профиля",
                        "delete": "Удаление профиля",
                        "up": "Запуск awg-quick",
                        "down": "Остановка через awg-quick",
                    }[action]
                    await asyncio.to_thread(self._change, action, value)
            except ValueError as exc:
                error = str(exc)
            except OSError as exc:
                error = f"{phase}: {system_error(exc)}."
            return {**await asyncio.to_thread(self._snapshot), "error": error}
