<?php
/**
 * Single sign-on voor phpMyAdmin (zie config.user.inc.php, auth_type signon).
 *
 * Het panel stuurt de gebruiker naar /phpmyadmin/signon.php?token=<eenmalig token>[&db=<naam>]. Dit script wisselt
 * het token server-to-server in bij het panel (POST /api/pma/exchange met Bearer PMA_SHARED_SECRET) voor de gegevens
 * van het MariaDB-account van deze gebruiker: per node een server (id, naam, poort, wachtwoord). Per server komt er
 * een eigen signon-sessie (PanelPmaSignon voor server 1, PanelPmaSignon_<id> voor de rest); sessies van servers die
 * niet meer in het antwoord staan, worden opgeruimd. Daarna door naar phpMyAdmin, op de server die het panel koos.
 * Zonder geldig token komt er geen sessie en dus geen toegang.
 */
declare(strict_types=1);

require_once '/etc/phpmyadmin/panel-servers.inc.php';

const SESSION_TTL = 3600; // gelijk aan LoginCookieValidity

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: SAMEORIGIN'); // ingebed in het panel (zelfde domein)

function fail(int $status, string $title, string $text): never
{
    http_response_code($status);
    header('Content-Type: text/html; charset=utf-8');
    $t = htmlspecialchars($title, ENT_QUOTES);
    $m = htmlspecialchars($text, ENT_QUOTES);
    echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        . '<title>phpMyAdmin</title><script src="panel-theme.js"></script><style>'
        . ':root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;'
        . 'background:#0b0b14;color:#f1f0fa}html.panel-light body{background:#f6f5fb;color:#1a1830}'
        . 'main{max-width:26rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0 1.25rem;opacity:.8}'
        . 'a{display:inline-block;padding:.55rem 1.1rem;border-radius:.75rem;background:#8b5cf6;color:#fff;text-decoration:none;font-weight:600}'
        . '</style><main><h1>' . $t . '</h1><p>' . $m . '</p><a href="/" target="_top">Back to the panel</a></main></html>';
    exit;
}

$token = $_GET['token'] ?? '';
if (!is_string($token) || !preg_match('/^[A-Za-z0-9_-]{20,100}$/', $token)) {
    fail(400, 'Sign-in link missing', 'Open phpMyAdmin from the panel to sign in.');
}

$secret = (string) getenv('PMA_SHARED_SECRET');
if (strlen($secret) < 32) {
    fail(500, 'phpMyAdmin is not configured', 'PMA_SHARED_SECRET is missing.');
}
$panel = rtrim((string) (getenv('PMA_PANEL_URL') ?: 'http://panel:3000'), '/');
// Optioneel meteen naar een database (vanaf de databasepagina van een server); het panel zegt op welke server die staat.
$db = $_GET['db'] ?? '';
$db = is_string($db) && preg_match('/^[A-Za-z0-9_]{1,64}$/', $db) ? $db : null;

// De image heeft allow_url_fopen uit; curl is er wel.
$ch = curl_init($panel . '/api/pma/exchange');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['token' => $token] + ($db !== null ? ['db' => $db] : [])),
    CURLOPT_HTTPHEADER => ["Authorization: Bearer $secret", 'Content-Type: application/json', 'Accept: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 30,
]);
$body = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);
if ($body === false || $status === 0) {
    fail(502, 'The panel is not reachable', 'Try again in a moment.');
}
if ($status === 401) {
    fail(401, 'Sign-in link expired', 'The link works once and for one minute. Open phpMyAdmin from the panel again.');
}
if ($status === 403) {
    fail(403, 'No databases', 'You do not have access to any database yet.');
}
if ($status !== 200) {
    fail(502, 'Sign-in failed', 'The panel could not prepare your database account (HTTP ' . $status . ').');
}
$data = json_decode($body, true);
if (!is_array($data) || !is_string($data['user'] ?? null) || !is_string($data['password'] ?? null) || !preg_match('/^pma_u[0-9]+$/', $data['user'])) {
    fail(502, 'Sign-in failed', 'Unexpected answer from the panel.');
}

// Servers uit het antwoord; een ouder panel zonder `servers` geeft alleen de lokale server.
$servers = [];
$list = is_array($data['servers'] ?? null) ? $data['servers'] : [['id' => 1, 'name' => 'MariaDB', 'local' => true, 'port' => 3306, 'password' => $data['password']]];
foreach ($list as $s) {
    if (!is_array($s) || !is_int($s['id'] ?? null) || $s['id'] < 1 || $s['id'] > 999999999 || !is_int($s['port'] ?? null) || $s['port'] < 1 || $s['port'] > 65535
        || !is_string($s['password'] ?? null) || $s['password'] === '' || !is_string($s['name'] ?? null) || !is_bool($s['local'] ?? null)
        || ($s['local'] !== ($s['id'] === 1))) {
        fail(502, 'Sign-in failed', 'Unexpected answer from the panel.');
    }
    $servers[$s['id']] = $s;
}
if ($servers === []) {
    fail(502, 'Sign-in failed', 'Unexpected answer from the panel.');
}
ksort($servers);
$select = is_int($data['select'] ?? null) && isset($servers[$data['select']]) ? $data['select'] : (int) array_key_first($servers);

session_set_cookie_params(panel_pma_cookie_params());
ini_set('session.gc_maxlifetime', (string) SESSION_TTL);
$tunnelHost = (string) (getenv('PMA_TUNNEL_HOST') ?: 'panel');
$localHost = (string) (getenv('PMA_DB_HOST') ?: 'panel-mariadb');

// Eén signon-sessie per server, elk met een nieuw id (geen fixatie).
foreach ($servers as $id => $s) {
    $name = panel_pma_session_name($id);
    session_name($name);
    $old = $_COOKIE[$name] ?? null;
    session_id(panel_pma_valid_session_id($old) ? $old : session_create_id());
    session_start();
    session_regenerate_id(true);
    $_SESSION = [
        'PMA_single_signon_user' => $data['user'],
        'PMA_single_signon_password' => $s['password'],
        'PMA_single_signon_host' => $s['local'] ? $localHost : $tunnelHost,
        'PMA_single_signon_port' => $s['local'] ? 3306 : $s['port'],
    ];
    session_write_close();
}
// Sessies van servers die de gebruiker niet (meer) heeft: weg, inclusief cookie (dan verdwijnen ze uit de serverkeuze).
foreach ($_COOKIE as $cname => $value) {
    $id = panel_pma_server_of_cookie((string) $cname);
    if ($id === null || isset($servers[$id])) {
        continue;
    }
    if (panel_pma_valid_session_id($value)) {
        session_name((string) $cname);
        session_id($value);
        session_start();
        $_SESSION = [];
        session_destroy();
    }
    $cp = panel_pma_cookie_params();
    setcookie((string) $cname, '', ['expires' => 1, 'path' => $cp['path'], 'secure' => $cp['secure'], 'httponly' => true, 'samesite' => $cp['samesite']]);
}
// Nodenamen voor de serverkeuze (config.user.inc.php).
$names = [];
foreach ($servers as $id => $s) {
    $names[$id] = mb_substr($s['name'], 0, 64);
}
panel_pma_write_names($names);

if ($db !== null) {
    $target = 'index.php?route=/database/structure&db=' . $db . ($select !== 1 ? '&server=' . $select : '');
} else {
    $target = $select !== 1 ? 'index.php?server=' . $select : 'index.php';
}
header('Location: ' . $target, true, 303);
