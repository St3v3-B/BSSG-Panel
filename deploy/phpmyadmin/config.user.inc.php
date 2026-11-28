<?php
/**
 * phpMyAdmin-configuratie van het panel. Wordt door /etc/phpmyadmin/config.inc.php van de image geladen.
 * Alles komt uit de omgeving van de container (deploy/docker-compose.yml); geen geheimen in dit bestand.
 *
 * - Per node met databases van de gebruiker een server (serverkeuze met de nodenamen). Server 1 is de lokale MariaDB
 *   (direct, PMA_DB_HOST:3306); een remote node N heeft sleutel N+1 en loopt via de tunnel van het panel
 *   (PMA_TUNNEL_HOST:<poort>, zie apps/web/server/pma-tunnel.ts) naar de daemon van die node.
 * - Single sign-on (signon.php): gebruikers typen nooit een wachtwoord; het panel geeft per login per node een eigen
 *   wachtwoord voor het MariaDB-account `pma_u<id>` met precies de rechten van die gebruiker op die node.
 * - Welke servers iemand ziet, volgt uit zijn signon-cookies (PanelPmaSignon = server 1, PanelPmaSignon_<n> = server n):
 *   signon.php zet alleen cookies voor de servers die het panel teruggaf. Host, poort en wachtwoord komen nooit uit
 *   de cookie maar uit de signon-sessie op de server; een vervalste cookie geeft dus alleen een lege server die
 *   terugverwijst naar het panel. De nodenamen staan in een bestand dat signon.php bijhoudt (geen geheimen).
 * - Geen vrije serverkeuze, geen root.
 */

$blowfish = (string) getenv('PMA_BLOWFISH_SECRET');
if (strlen($blowfish) < 32) {
    // Liever niet starten dan met een zwak of ontbrekend geheim.
    http_response_code(500);
    exit('PMA_BLOWFISH_SECRET is missing or too short');
}
$cfg['blowfish_secret'] = $blowfish;

require_once __DIR__ . '/panel-servers.inc.php';

// De image zet zelf een server uit PMA_HOST(S); wij bepalen de lijst zelf.
$panelCommon = [
    'compress' => false,
    'auth_type' => 'signon',
    'LogoutURL' => '/phpmyadmin/panel-return.html?logout=1',
    'AllowRoot' => false,
    'AllowNoPassword' => false,
    'hide_db' => '^(information_schema|performance_schema|mysql|sys)$',
];
$panelRemote = [];
foreach ($_COOKIE as $panelCookie => $panelValue) {
    $panelId = panel_pma_server_of_cookie((string) $panelCookie);
    if ($panelId !== null && $panelId > 1 && is_string($panelValue) && $panelValue !== '') {
        $panelRemote[$panelId] = true;
    }
}
ksort($panelRemote);
$panelNames = panel_pma_read_names();
$cfg['Servers'] = [];
// Server 1 (lokaal) zoals altijd; ook als er nog geen enkele sessie is (dan stuurt phpMyAdmin naar het panel).
if (isset($_COOKIE[panel_pma_session_name(1)]) || $panelRemote === []) {
    $cfg['Servers'][1] = $panelCommon + [
        'verbose' => $panelRemote === [] ? 'MariaDB' : ($panelNames[1] ?? 'MariaDB'),
        'host' => getenv('PMA_DB_HOST') ?: 'panel-mariadb',
        'port' => 3306,
        'SignonSession' => panel_pma_session_name(1),
        // Niet (meer) ingelogd: terug naar het panel, dat opnieuw een token geeft (zie panel-return.js; werkt ook ingebed).
        'SignonURL' => '/phpmyadmin/panel-return.html',
    ];
}
foreach (array_keys($panelRemote) as $panelId) {
    $cfg['Servers'][$panelId] = $panelCommon + [
        'verbose' => $panelNames[$panelId] ?? ('Node ' . ($panelId - 1)),
        // Host en poort komen uit de signon-sessie (de tunnelpoort van deze node); dit is alleen een standaard.
        'host' => getenv('PMA_TUNNEL_HOST') ?: 'panel',
        'port' => 0,
        'SignonSession' => panel_pma_session_name($panelId),
        // Mislukt verbinden (node offline) of sessie verlopen: eigen pagina, geen eindeloze herlogin-lus.
        'SignonURL' => '/phpmyadmin/panel-unreachable.php?server=' . $panelId,
    ];
}
$cfg['ServerDefault'] = (int) array_key_first($cfg['Servers']);
unset($panelCommon, $panelRemote, $panelNames, $panelCookie, $panelValue, $panelId);

$cfg['AllowArbitraryServer'] = false;
$cfg['LoginCookieValidity'] = 3600;
$cfg['LoginCookieStore'] = 0;
$cfg['ExecTimeLimit'] = 300;

// Thema (zie themes/bssg) en rust in de interface.
$cfg['ThemeDefault'] = 'bssg';
$cfg['ThemeManager'] = false;
$cfg['VersionCheck'] = false;
$cfg['SendErrorReports'] = 'never';
$cfg['ShowChgPassword'] = false;   // het wachtwoord wordt bij elke login door het panel vervangen
$cfg['ShowCreateDb'] = false;      // databases maak je in het panel (de gebruiker mag het ook niet)
$cfg['AllowUserDropDatabase'] = true;
$cfg['CheckConfigurationPermissions'] = false;
$cfg['DefaultLang'] = 'en';
$cfg['PmaNoRelation_DisableWarning'] = true; // geen phpMyAdmin-opslagdatabase (pmadb); geen melding op de startpagina
$cfg['ShowPhpInfo'] = false;
$cfg['ShowServerInfo'] = false;
$cfg['NavigationLinkWithMainPanel'] = true;
// Het panel toont phpMyAdmin ingebed op /databases (zelfde domein); andere sites mogen dat niet.
$cfg['AllowThirdPartyFraming'] = 'sameorigin';
$cfg['TitleDefault'] = 'phpMyAdmin';
$cfg['TitleServer'] = 'phpMyAdmin';
$cfg['TitleDatabase'] = '@DATABASE@ · phpMyAdmin';
$cfg['TitleTable'] = '@TABLE@ · @DATABASE@ · phpMyAdmin';
