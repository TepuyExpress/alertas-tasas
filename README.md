# Tepuy Express · Alertas de tasas

Monitor EUR → VES de CambiaTusEuros, Curiara y RemittVen. Usa las API públicas de sus calculadoras, verificadas el 29/09/2026. No usa valores de respaldo del HTML ni tokens de chats.

## Funcionamiento

- Cloudflare Worker gratuito, programado a los minutos 07 y 37 UTC: intervalo nominal de 30 minutos, con el ordenador apagado.
- Telegram muestra tasa anterior, nueva, variación absoluta/porcentual, intervalo de detección y tasa máxima. Primera ejecución: aviso de inicio.
- Transferencia bancaria comparada entre las tres empresas. Pago Móvil de RemittVen separado. Tasas brutas, sin descontar comisiones.
- Varios cambios en la misma revisión: orden real indeterminado. El orden de respuesta de red no prueba quién cambió primero.
- D1 conserva todas las observaciones y fallos. Estado, historial y cola de mensajes se guardan en una transacción; bloqueo contra ejecuciones concurrentes.
- Fuentes fallidas quedan fuera del ranking. Avisos de fallo y recuperación solo en las transiciones.
- Mensajes pendientes se reintentan en la siguiente revisión. Si Telegram recibe un aviso pero se pierde su confirmación, podría repetirse con el mismo ID.

## Intervalo real

Cloudflare evita depender de las colas de GitHub Actions. El objetivo es 30 minutos, sin garantía de puntualidad exacta ni SLA gratuito. La propagación inicial del Cron puede tardar 15 minutos. El intervalo real se mide con las horas guardadas en D1. GitHub Actions solo valida el código: sus tareas programadas pueden retrasarse, omitirse o desactivarse tras inactividad.

## Despliegue y secretos

Crear D1 `tepuy-alertas-historial`, actualizar su ID en `wrangler.jsonc` y enlazarlo al Worker como `DB`. Guardar `TELEGRAM_BOT_TOKEN` nuevo y `TELEGRAM_CHAT_ID` como **Secret en Cloudflare**. Los secretos de GitHub no se transfieren automáticamente. Pulsar Iniciar en el bot de Telegram. Añadir Cron `7,37 * * * *`.

La dirección pública solo muestra una descripción, no permite lanzar avisos ni ver historial. Comprobar aviso inicial, tres fuentes correctas y `outbox.sent_at` no nulo. Verificar dos ejecuciones programadas consecutivas antes de afirmar un intervalo observado.

## Historial (consola D1)

```sql
SELECT * FROM history ORDER BY observed_at DESC LIMIT 48;
SELECT id, sent_at, attempts FROM outbox ORDER BY rowid DESC LIMIT 20;
SELECT observed_at,
 ROUND((julianday(observed_at)-julianday(LAG(observed_at) OVER (ORDER BY observed_at)))*1440,2) AS minutes_since_previous
FROM history ORDER BY observed_at DESC LIMIT 48;
```

Exportar D1 periódicamente y revisar el uso: el almacenamiento gratuito no es ilimitado. Si el Worker entero deja de ejecutarse, este monitor no puede avisar de su propia ausencia.

## Pruebas

Node 22 o posterior; sin dependencias. `npm test` ejecuta pruebas. `npm run probe` consulta las tasas reales y prepara un ejemplo, **sin enviar Telegram**.

## Fuentes verificadas

- https://cambiatuseuros.com/ → https://api.cambiatuseuros.com/api/rate (EUR/BS).
- https://curiara.com/europa/ → API de app.curiara.com: España/EUR, Venezuela/VES, método Bank, cotización no indicativa.
- https://remittven.es/ → `/api/rates.php`, `rates.account` y `rates.mobile_transfer`. Rechaza caché mayor de dos horas y valores inválidos.
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule

Si cambia la estructura de las API, falla explícitamente y avisa; no inventa tasas.
