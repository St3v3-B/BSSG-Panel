<?php
/**
 * SignonURL van de servers voor remote nodes (config.user.inc.php). phpMyAdmin komt hier als:
 * - de signon-sessie leeg of verlopen is: dan terug naar het panel voor een nieuwe login (panel-return.html), net als
 *   bij server 1;
 * - verbinden mislukte (node offline, MariaDB weg): dan een nette melding met een weg terug, in plaats van een
 *   eindeloze herlogin-lus. De andere servers blijven gewoon werken.
 */
declare(strict_types=1);

require_once '/etc/phpmyadmin/panel-servers.inc.php';

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Frame-Options: SAMEORIGIN');

$id = $_GET['server'] ?? '';
$id = is_string($id) && preg_match('/^[1-9][0-9]{0,8}$/', $id) ? (int) $id : 0;
$name = $id > 1 ? panel_pma_session_name($id) : '';
$state = null;
if ($name !== '' && panel_pma_valid_session_id($_COOKIE[$name] ?? null)) {
    session_set_cookie_params(panel_pma_cookie_params());
    session_name($name);
    session_id($_COOKIE[$name]);
    session_start(['read_and_close' => true]);
    $state = $_SESSION;
}
if (!is_array($state) || !is_string($state['PMA_single_signon_user'] ?? null)) {
    header('Location: panel-return.html', true, 303);
    exit;
}

$names = panel_pma_read_names();
$node = $names[$id] ?? ('Node ' . ($id - 1));
$msg = is_string($state['PMA_single_signon_error_message'] ?? null) ? $state['PMA_single_signon_error_message'] : '';
// Andere server om naar terug te gaan: de eerste met een sessie (meestal server 1).
$back = null;
foreach ($_COOKIE as $c => $v) {
    $other = panel_pma_server_of_cookie((string) $c);
    if ($other !== null && $other !== $id && is_string($v) && $v !== '' && ($back === null || $other < $back)) {
        $back = $other;
    }
}
http_response_code(503);
header('Content-Type: text/html; charset=utf-8');
$h = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES);
echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    . '<title>phpMyAdmin</title><script src="panel-theme.js"></script><style>'
    . ':root{color-scheme:dark light}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;'
    . 'background:#0b0b14;color:#f1f0fa}html.panel-light body{background:#f6f5fb;color:#1a1830}'
    . 'main{max-width:30rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:.5rem 0 1.25rem;opacity:.8}'
    . 'small{display:block;margin:0 0 1.25rem;opacity:.6;word-break:break-word}'
    . 'a{display:inline-block;margin:.25rem;padding:.55rem 1.1rem;border-radius:.75rem;background:#8b5cf6;color:#fff;text-decoration:none;font-weight:600}'
    . 'a.alt{background:transparent;border:1px solid #8b5cf6;color:inherit}'
    . '</style><main data-panel-unreachable="' . $id . '"><h1>' . $h($node) . ' is not reachable</h1>'
    . '<p>The databases on this node can\'t be opened right now. The node may be offline; try again in a moment.</p>'
    . ($msg !== '' ? '<small>' . $h(mb_substr($msg, 0, 300)) . '</small>' : '')
    . ($back !== null ? '<a href="index.php?server=' . $back . '">Back to ' . $h($names[$back] ?? 'the other databases') . '</a>' : '')
    . '<a class="alt" href="panel-return.html">Sign in again</a></main></html>';
