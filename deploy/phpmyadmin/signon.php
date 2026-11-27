<?php
/**
 * Single sign-on voor phpMyAdmin (zie config.user.inc.php, auth_type signon).
 *
 * Het panel stuurt de gebruiker naar /phpmyadmin/signon.php?token=<eenmalig token>. Dit script wisselt het token
 * server-to-server in bij het panel (POST /api/pma/exchange met Bearer PMA_SHARED_SECRET) voor de gegevens van het
 * MariaDB-account van deze gebruiker, zet die in de signon-sessie en stuurt door naar phpMyAdmin.
 * Zonder geldig token komt er geen sessie en dus geen toegang.
 */
declare(strict_types=1);

const SESSION_NAME = 'PanelPmaSignon';
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

// De image heeft allow_url_fopen uit; curl is er wel.
$ch = curl_init($panel . '/api/pma/exchange');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => json_encode(['token' => $token]),
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

$https = str_starts_with((string) getenv('PMA_ABSOLUTE_URI'), 'https://');
session_name(SESSION_NAME);
session_set_cookie_params([
    'lifetime' => SESSION_TTL,
    'path' => '/phpmyadmin/',
    'secure' => $https,
    'httponly' => true,
    'samesite' => 'Lax',
]);
ini_set('session.gc_maxlifetime', (string) SESSION_TTL);
session_start();
session_regenerate_id(true);
$_SESSION = [
    'PMA_single_signon_user' => $data['user'],
    'PMA_single_signon_password' => $data['password'],
    'PMA_single_signon_host' => (string) (getenv('PMA_DB_HOST') ?: 'panel-mariadb'),
    'PMA_single_signon_port' => 3306,
];
session_write_close();

// Optioneel meteen naar een database (vanaf de databasepagina van een server).
$db = $_GET['db'] ?? '';
$target = is_string($db) && preg_match('/^[A-Za-z0-9_]{1,64}$/', $db) ? 'index.php?route=/database/structure&db=' . $db : 'index.php';
header('Location: ' . $target, true, 303);
