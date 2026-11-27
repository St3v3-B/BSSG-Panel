<?php
/**
 * Gedeelde hulpfuncties voor config.user.inc.php, signon.php en panel-unreachable.php (meerdere nodes).
 *
 * - Server 1 = lokale MariaDB, signon-sessie `PanelPmaSignon` (zoals voorheen).
 * - Server n > 1 = remote node n-1, signon-sessie `PanelPmaSignon_<n>`.
 * - Nodenamen voor de serverkeuze staan in een klein JSON-bestand in de tijdelijke map (alleen namen, geen geheimen);
 *   signon.php werkt het bij met de namen uit het antwoord van het panel.
 */
declare(strict_types=1);

if (!function_exists('panel_pma_session_name')) {
    function panel_pma_session_name(int $id): string
    {
        return $id === 1 ? 'PanelPmaSignon' : 'PanelPmaSignon_' . $id;
    }

    /** Sleutel bij een cookienaam, of null als het geen signon-cookie is. */
    function panel_pma_server_of_cookie(string $name): ?int
    {
        if ($name === 'PanelPmaSignon') {
            return 1;
        }
        if (preg_match('/^PanelPmaSignon_([1-9][0-9]{0,8})$/', $name, $m)) {
            return (int) $m[1];
        }
        return null;
    }

    function panel_pma_names_file(): string
    {
        return rtrim(sys_get_temp_dir(), '/') . '/panel-pma-servers.json';
    }

    /** @return array<int,string> */
    function panel_pma_read_names(): array
    {
        $raw = @file_get_contents(panel_pma_names_file());
        $data = is_string($raw) ? json_decode($raw, true) : null;
        $out = [];
        if (is_array($data)) {
            foreach ($data as $k => $v) {
                if (is_numeric($k) && (int) $k >= 1 && is_string($v) && $v !== '') {
                    $out[(int) $k] = mb_substr($v, 0, 64);
                }
            }
        }
        return $out;
    }

    /** @param array<int,string> $names */
    function panel_pma_write_names(array $names): void
    {
        $all = panel_pma_read_names();
        $changed = false;
        foreach ($names as $k => $v) {
            if (($all[$k] ?? null) !== $v) {
                $all[$k] = $v;
                $changed = true;
            }
        }
        if (!$changed) {
            return;
        }
        $file = panel_pma_names_file();
        $tmp = $file . '.' . bin2hex(random_bytes(6));
        if (@file_put_contents($tmp, json_encode($all, JSON_UNESCAPED_UNICODE)) !== false) {
            @chmod($tmp, 0644);
            @rename($tmp, $file);
        }
        @unlink($tmp);
    }

    /** Sessiecookies van de signon-sessies (zelfde instellingen als altijd). */
    function panel_pma_cookie_params(): array
    {
        return [
            'lifetime' => 3600, // gelijk aan LoginCookieValidity
            'path' => '/phpmyadmin/',
            'secure' => str_starts_with((string) getenv('PMA_ABSOLUTE_URI'), 'https://'),
            'httponly' => true,
            'samesite' => 'Lax',
        ];
    }

    function panel_pma_valid_session_id(mixed $v): bool
    {
        return is_string($v) && preg_match('/^[A-Za-z0-9,-]{22,256}$/', $v) === 1;
    }
}
