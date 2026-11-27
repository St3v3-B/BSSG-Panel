# phpMyAdmin voor het panel: de officiele image (versie gepind) met onze configuratie, het single-sign-on-script
# en het thema "bssg" (gebaseerd op het ingebouwde Bootstrap-thema, zie themes/bssg/README.md).
# Alles zit in de image, zodat een upgrade van het panel ook dit onderdeel bijwerkt.
FROM phpmyadmin:5.2.3-apache

# Thema: kopie van het Bootstrap-thema met onze css en afbeeldingen eroverheen.
COPY themes/bssg /tmp/bssg
RUN set -eu; \
    cd /var/www/html/themes; \
    cp -r bootstrap bssg; \
    cp -r /tmp/bssg/img/. bssg/img/; \
    cp /tmp/bssg/theme.json bssg/theme.json; \
    cat /tmp/bssg/css/overrides.css >> bssg/css/theme.css; \
    cat /tmp/bssg/css/overrides.css >> bssg/css/theme.rtl.css; \
    rm -f bssg/css/theme.css.map bssg/css/theme.rtl.css.map; \
    rm -rf /tmp/bssg; \
    chown -R root:root bssg; \
    chmod -R a+rX bssg

# De entrypoint schrijft anders zelf een willekeurig blowfish-geheim naar /etc/phpmyadmin; dat lukt niet zonder
# DAC_OVERRIDE (de map is van www-data). Ons geheim komt uit PMA_BLOWFISH_SECRET (config.user.inc.php).
RUN printf '<?php\n// blowfish_secret: zie config.user.inc.php\n' > /etc/phpmyadmin/config.secret.inc.php \
 && chown root:www-data /etc/phpmyadmin/config.secret.inc.php && chmod 0640 /etc/phpmyadmin/config.secret.inc.php

COPY config.user.inc.php /etc/phpmyadmin/config.user.inc.php
COPY signon.php /var/www/html/signon.php
RUN chmod 0644 /etc/phpmyadmin/config.user.inc.php /var/www/html/signon.php \
 && rm -rf /var/www/html/doc /var/www/html/ChangeLog /var/www/html/README /var/www/html/LICENSE
