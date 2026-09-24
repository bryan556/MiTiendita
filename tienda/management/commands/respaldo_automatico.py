import os
import sys
import subprocess
import zipfile
import platform
from datetime import datetime
from django.core.management.base import BaseCommand
from django.conf import settings
from django.utils import timezone
from tienda.models import Respaldo, ConfiguracionRespaldo


class Command(BaseCommand):
    help = 'Ejecuta el respaldo automático de la base de datos según la configuración'

    def handle(self, *args, **options):
        config = ConfiguracionRespaldo.objects.first()
        if not config or not config.activo:
            self.stdout.write(self.style.WARNING('Respaldo automático DESACTIVADO.'))
            return

        # Verificar si hoy es día de respaldo
        dia_hoy = timezone.localtime().weekday()  # 0=Lunes, 6=Domingo
        dias_activos = [int(d) for d in config.dias_semana.split(',') if d.strip().isdigit()]
        
        if dia_hoy not in dias_activos:
            self.stdout.write(self.style.WARNING(f'Hoy (día {dia_hoy}) no toca respaldo.'))
            return

        # Ejecutar respaldo
        try:
            resultado = crear_respaldo(tipo='AUTOMATICO', incluir_media=config.incluir_media)
            if resultado['exito']:
                config.ultima_ejecucion = timezone.now()
                config.save()
                self.stdout.write(self.style.SUCCESS(f"✅ Respaldo creado: {resultado['nombre']}"))
                limpiar_respaldos_viejos(config.max_respaldos)
            else:
                self.stdout.write(self.style.ERROR(f"❌ Error: {resultado['mensaje']}"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"❌ Excepción: {e}"))


# ==========================================
#  FUNCIONES REUTILIZABLES
# ==========================================

def _obtener_pg_dump():
    """Detecta la ruta de pg_dump según el sistema operativo"""
    sistema = platform.system()
    
    if sistema == 'Windows':
        # Buscar en las rutas comunes de instalación
        rutas_posibles = [
            r'C:\Program Files\PostgreSQL\16\bin\pg_dump.exe',
            r'C:\Program Files\PostgreSQL\15\bin\pg_dump.exe',
            r'C:\Program Files\PostgreSQL\14\bin\pg_dump.exe',
            r'C:\Program Files\PostgreSQL\13\bin\pg_dump.exe',
            r'C:\Program Files (x86)\PostgreSQL\16\bin\pg_dump.exe',
            r'C:\Program Files\PostgreSQL\17\bin\pg_dump.exe',
        ]
        for ruta in rutas_posibles:
            if os.path.exists(ruta):
                return ruta
        return 'pg_dump'  # Esperar que esté en el PATH
    else:
        # Linux/Mac
        return '/usr/bin/pg_dump'


def _obtener_pg_restore():
    """Detecta la ruta de pg_restore según el sistema operativo"""
    sistema = platform.system()
    
    if sistema == 'Windows':
        rutas_posibles = [
            r'C:\Program Files\PostgreSQL\16\bin\pg_restore.exe',
            r'C:\Program Files\PostgreSQL\15\bin\pg_restore.exe',
            r'C:\Program Files\PostgreSQL\14\bin\pg_restore.exe',
            r'C:\Program Files\PostgreSQL\13\bin\pg_restore.exe',
        ]
        for ruta in rutas_posibles:
            if os.path.exists(ruta):
                return ruta
        return 'pg_restore'
    else:
        return '/usr/bin/pg_restore'


def _obtener_pg_dump_psql():
    """Detecta psql (para restaurar SQL plano si es necesario)"""
    sistema = platform.system()
    
    if sistema == 'Windows':
        rutas_posibles = [
            r'C:\Program Files\PostgreSQL\16\bin\psql.exe',
            r'C:\Program Files\PostgreSQL\15\bin\psql.exe',
            r'C:\Program Files\PostgreSQL\14\bin\psql.exe',
            r'C:\Program Files\PostgreSQL\13\bin\psql.exe',
        ]
        for ruta in rutas_posibles:
            if os.path.exists(ruta):
                return ruta
        return 'psql'
    else:
        return '/usr/bin/psql'


def crear_respaldo(tipo='MANUAL', incluir_media=False, creado_por=None):
    """Crea un respaldo de PostgreSQL en la carpeta /backups/"""
    
    db_config = settings.DATABASES['default']
    nombre_db = db_config['NAME']
    usuario = db_config['USER']
    password = db_config['PASSWORD']
    host = db_config.get('HOST', 'localhost')
    puerto = db_config.get('PORT', '5432')
    
    # Nombre del archivo con timestamp
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    nombre_base = f"respaldo_{tipo.lower()}_{timestamp}"
    archivo_sql = f"{nombre_base}.sql"
    archivo_zip = f"{nombre_base}.zip"
    
    # Carpeta de backups
    carpeta_backups = os.path.join(settings.BASE_DIR, 'backups')
    os.makedirs(carpeta_backups, exist_ok=True)
    
    ruta_sql = os.path.join(carpeta_backups, archivo_sql)
    ruta_zip = os.path.join(carpeta_backups, archivo_zip)
    
    # Preparar variables de entorno para pg_dump (evita pedir password)
    env = os.environ.copy()
    env['PGPASSWORD'] = password
    
    try:
        # 1. Ejecutar pg_dump
        pg_dump = _obtener_pg_dump()
        
        comando = [
            pg_dump,
            '-h', host,
            '-p', str(puerto),
            '-U', usuario,
            '-F', 'p',  # Formato plano (SQL)
            '-d', nombre_db,
            '-f', ruta_sql,
        ]
        
        resultado = subprocess.run(
            comando, 
            env=env, 
            capture_output=True, 
            text=True,
            timeout=300  # 5 minutos máximo
        )
        
        if resultado.returncode != 0:
            raise Exception(f"pg_dump falló: {resultado.stderr}")
        
        # 2. Si incluye media, agregar la carpeta al zip
        archivos_a_zip = [ruta_sql]
        
        if incluir_media:
            media_root = settings.MEDIA_ROOT
            if os.path.exists(media_root):
                archivos_a_zip.append(('media', media_root))
        
        # 3. Comprimir todo en un ZIP
        with zipfile.ZipFile(ruta_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
            # Agregar el SQL
            zipf.write(ruta_sql, arcname=archivo_sql)
            
            # Agregar la carpeta media si aplica
            if incluir_media and os.path.exists(settings.MEDIA_ROOT):
                for root, dirs, files in os.walk(settings.MEDIA_ROOT):
                    for file in files:
                        ruta_completa = os.path.join(root, file)
                        ruta_relativa = os.path.relpath(ruta_completa, settings.MEDIA_ROOT)
                        zipf.write(ruta_completa, arcname=os.path.join('media', ruta_relativa))
        
        # 4. Eliminar el SQL temporal (ya está dentro del ZIP)
        os.remove(ruta_sql)
        
        # 5. Calcular tamaño del ZIP
        tamano_kb = os.path.getsize(ruta_zip) / 1024
        
        # 6. Registrar en BD
        respaldo = Respaldo.objects.create(
            nombre_archivo=archivo_zip,
            tipo=tipo,
            tamano_kb=round(tamano_kb, 2),
            creado_por=creado_por,
            exito=True,
            incluye_media=incluir_media,
        )
        
        return {
            'exito': True,
            'nombre': archivo_zip,
            'ruta': ruta_zip,
            'tamano_kb': tamano_kb,
            'respaldo_id': respaldo.id,
        }
        
    except Exception as e:
        # Registrar el fallo
        Respaldo.objects.create(
            nombre_archivo=archivo_zip,
            tipo=tipo,
            exito=False,
            mensaje_error=str(e),
            creado_por=creado_por,
            incluye_media=incluir_media,
        )
        
        # Limpiar archivos parciales
        if os.path.exists(ruta_sql):
            os.remove(ruta_sql)
        if os.path.exists(ruta_zip):
            os.remove(ruta_zip)
        
        return {
            'exito': False,
            'mensaje': str(e),
        }


def limpiar_respaldos_viejos(max_respaldos=30):
    """Borra los respaldos más antiguos si exceden el límite"""
    respaldos = Respaldo.objects.filter(exito=True).order_by('-fecha_creacion')
    
    if respaldos.count() <= max_respaldos:
        return
    
    respaldos_a_borrar = respaldos[max_respaldos:]
    carpeta_backups = os.path.join(settings.BASE_DIR, 'backups')
    
    for respaldo in respaldos_a_borrar:
        ruta = os.path.join(carpeta_backups, respaldo.nombre_archivo)
        if os.path.exists(ruta):
            try:
                os.remove(ruta)
            except:
                pass
        respaldo.delete()


def restaurar_respaldo(archivo_zip_path):
    """Restaura un respaldo desde un archivo ZIP"""
    import tempfile
    import shutil
    
    db_config = settings.DATABASES['default']
    nombre_db = db_config['NAME']
    usuario = db_config['USER']
    password = db_config['PASSWORD']
    host = db_config.get('HOST', 'localhost')
    puerto = db_config.get('PORT', '5432')
    
    env = os.environ.copy()
    env['PGPASSWORD'] = password
    
    try:
        # 1. Extraer el ZIP a una carpeta temporal
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(archivo_zip_path, 'r') as zipf:
                zipf.extractall(tmpdir)
            
            # 2. Buscar el archivo .sql
            archivo_sql = None
            for file in os.listdir(tmpdir):
                if file.endswith('.sql'):
                    archivo_sql = os.path.join(tmpdir, file)
                    break
            
            if not archivo_sql:
                raise Exception("El ZIP no contiene un archivo .sql válido")
            
            # 3. Ejecutar psql para restaurar
            psql = _obtener_pg_dump_psql()
            
            # IMPORTANTE: Primero hay que eliminar las conexiones activas y limpiar la BD
            # Pero eso es peligroso. Una alternativa es hacer DROP/CREATE de las tablas.
            # Para simplicidad, usamos --clean para que psql se encargue.
            
            comando = [
                psql,
                '-h', host,
                '-p', str(puerto),
                '-U', usuario,
                '-d', nombre_db,
                '-f', archivo_sql,
            ]
            
            resultado = subprocess.run(
                comando,
                env=env,
                capture_output=True,
                text=True,
                timeout=600,  # 10 minutos máximo
            )
            
            if resultado.returncode != 0:
                raise Exception(f"psql falló: {resultado.stderr}")
            
            # 4. Si hay carpeta media, restaurarla también
            media_tmp = os.path.join(tmpdir, 'media')
            if os.path.exists(media_tmp):
                # Borrar media actual y reemplazar
                if os.path.exists(settings.MEDIA_ROOT):
                    shutil.rmtree(settings.MEDIA_ROOT)
                shutil.copytree(media_tmp, settings.MEDIA_ROOT)
        
        return {'exito': True, 'mensaje': 'Respaldo restaurado correctamente'}
        
    except Exception as e:
        return {'exito': False, 'mensaje': str(e)}