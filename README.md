# Codex Link

Plugin experimental de Codex para comunicar dos agentes mediante una sala temporal. La parte local cifra y autentica cada mensaje con AES-256-GCM antes de enviarlo; el relé de desarrollo solo acepta sobres cifrados. El repositorio no incluye un Site provisionado, IDs de proyecto ni secretos: cada despliegue necesita su propia configuración privada.

## Estado

- Plugin Codex local con servidor MCP por `stdio` y un skill de uso seguro.
- Invitación aleatoria de 256 bits por sala; el secreto no forma parte de las peticiones al relé.
- Clave por emisor derivada con HKDF-SHA-256; nonce aleatorio por mensaje; rechazo de alteraciones y repetición.
- Relé de desarrollo en memoria, sin base de datos, archivos de mensajes ni registro del cuerpo.
- Pruebas de cifrado, manipulación, replay, entrega y confirmación local.
- Adaptador Worker ESM para Sites en `site/worker/index.js`; coordina instancias mediante D1 y guarda únicamente metadatos y ciphertext.
- D1 elimina lógicamente los mensajes al recibir ACK o al caducar (cinco minutos), y las salas a los 30 minutos. La limpieza de filas caducadas es oportunista; no hay garantía de eliminación física inmediata.
- Las copias de recuperación del proveedor podrían conservar ciphertext después del borrado lógico. Consulta la retención vigente de D1 para tu cuenta antes de usarlo.
- Las pruebas locales comprueban acceso desde dos instancias Worker contra una misma base SQLite real. Esto valida el diseño SQL/protocolo, no sustituye la prueba alojada desde dos ordenadores.

## Correr las pruebas

Requiere Node.js 20 o posterior; las pruebas de integración SQLite de D1 se ejecutan con Node.js 22.5 o posterior (en versiones anteriores se omiten). No hacen falta paquetes de npm:

```powershell
npm test
```

## Probar el relé local

En una terminal:

```powershell
npm run relay
```

El proceso escucha solo en `127.0.0.1:8787`. Las colas viven en RAM, expiran en cinco minutos y se purgan al confirmar la recepción o al detener el proceso. Las salas expiran en 30 minutos. No se escribe contenido en disco.

Para una prueba automatizada completa se usa `npm test`; no hace falta cambiar variables del usuario ni abrir puertos en el router.

## Seguridad y límites

- El relé no recibe texto plano ni el secreto de invitación. Sí observa IDs aleatorios, participantes, tamaño aproximado y tiempos; además puede bloquear, retrasar, descartar o repetir paquetes.
- La invitación es una credencial portadora. Compártela fuera del canal y solo con el otro ordenador deseado. No la envíes con `codex_link_send`.
- Los secretos permanecen solo en memoria del proceso MCP. Reiniciar Codex o el servidor requiere crear una sala nueva.
- El texto aparece en las conversaciones de ambos agentes y, por tanto, es visible para sus modelos/proveedores y usuarios. El cifrado no oculta esos extremos.
- El prototipo no tiene auditoría criptográfica independiente ni forward secrecy: quien obtenga el código de invitación de una sesión podría derivar sus claves. Usa una invitación nueva por sesión y no reutilices códigos.
- El relé alojado usa D1 porque el almacenamiento compartido entre instancias es necesario para el puente. D1 guarda solo sobres cifrados y metadatos limitados; ten en cuenta que el historial de Time Travel puede retener ciphertext borrado durante más tiempo que el TTL lógico.

## Instalar y configurar el plugin

En cada ordenador, clona este repositorio y, desde su carpeta raíz, registra e instala el plugin:

```powershell
codex plugin marketplace add .
codex plugin add codex-link@codex-link-local
```

Después ejecuta `plugin/scripts/configure-windows.ps1`. El asistente solicita el origen HTTPS exacto del Site y los dos tokens; los guarda como variables de entorno del usuario de Windows, no en el repositorio. Cualquier proceso ejecutado con esa cuenta podrá leer esas variables. Reinicia Codex para que el plugin las herede. Configura ambos ordenadores con el mismo Site privado y los mismos tokens; comparte los tokens solo por un canal de confianza.

El `.mcp.json` del plugin inicia el servidor local y permite únicamente el origen configurado en `CODEX_LINK_SITES_ALLOWED_ORIGIN`. Un relé remoto exige HTTPS y un token de aplicación separado de la clave E2E; para Sites privados, el token de servicio solo se envía a ese origen exacto.

Para provisionar un Site propio, copia `site/.openai/hosting.example.json` como `site/.openai/hosting.json` y sustituye el `project_id` vacío por el ID real devuelto al crear tu Site privado. El manifiesto real, los tokens y el artefacto compilado son locales y están excluidos del repositorio.
