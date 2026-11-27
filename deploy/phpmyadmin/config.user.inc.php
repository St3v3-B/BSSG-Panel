<?php
/**
 * phpMyAdmin-configuratie van het panel. Wordt door /etc/phpmyadmin/config.inc.php van de image geladen.
 * Alles komt uit de omgeving van de container (deploy/docker-compose.yml); geen geheimen in dit bestand.
 *
 * - Eén server: de lokale MariaDB, met single sign-on (signon.php). Gebruikers typen nooit een wachtwoord:
 *   het panel geeft per login een eigen MariaDB-account `pma_u<id>` met precies de rechten van die gebruiker.
 * - Geen vrije serverkeuze, geen root.
 */

$blowfish = (string) getenv('PMA_BLOWFISH_SECRET');
if (strlen($blowfish) < 32) {
    // Liever niet starten dan met een zwak of ontbrekend geheim.
    http_response_code(500);
    exit('PMA_BLOWFISH_SECRET is missing or too short');
}
$cfg['blowfish_secret'] = $blowfish;

// De image zet zelf een server uit PMA_HOST(S); wij willen precies één, vast.
$cfg['Servers'] = [];
$cfg['Servers'][1] = [
    'verbose' => 'MariaDB',
    'host' => getenv('PMA_DB_HOST') ?: 'panel-mariadb',
    'port' => 3306,
    'compress' => false,
    'auth_type' => 'signon',
    'SignonSession' => 'PanelPmaSignon',
    // Niet (meer) ingelogd: terug naar het panel, dat opnieuw een token geeft.
    'SignonURL' => '/',
    'LogoutURL' => '/',
    'AllowRoot' => false,
    'AllowNoPassword' => false,
    'hide_db' => '^(information_schema|performance_schema|mysql|sys)$',
];

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
