import os
import sys
import subprocess
import zipfile
import platform
import shutil
import tempfile
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
#  FUNCIONES DETECCIÓN POSTGRESQL (FALLBACK)
# ==========================================

def _obtener_pg_dump():
    sistema = platform.system()
    if sistema == 'Windows':
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
        return 'pg_dump'
    else:
        return '/usr/bin/pg_dump'


def _obtener_pg_dump_psql():
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


# ==========================================
#  FUNCIONES PRINCIPALES (SQLITE & POSTGRES)
# ==========================================

def crear_respaldo(tipo='MANUAL', incluir_media=False, creado_por=None):
    """Crea un respaldo dinámico (SQLite o PostgreSQL) dentro de un ZIP en /backups/"""
    
    db_config = settings.DATABASES['default']
    es_sqlite = 'sqlite3' in db_config['ENGINE']
    
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    nombre_base = f"respaldo_{tipo.lower()}_{timestamp}"
    archivo_zip = f"{nombre_base}.zip"
    
    carpeta_backups = os.path.join(settings.BASE_DIR, 'backups')
    os.makedirs(carpeta_backups, exist_ok=True)
    ruta_zip = os.path.join(carpeta_backups, archivo_zip)
    
    ruta_temp_db = None

    try:
        with zipfile.ZipFile(ruta_zip, 'w', zipfile.ZIP_DEFLATED) as zipf:
            
            # --- CASO A: SQLITE ---
            if es_sqlite:
                db_path = db_config['NAME']
                if not os.path.exists(db_path):
                    raise Exception(f"No se encontró el archivo de base de datos SQLite en: {db_path}")
                
                # Nombre con el que se guardará dentro del zip
                nombre_db_zip = "db.sqlite3"
                zipf.write(db_path, arcname=nombre_db_zip)

            # --- CASO B: POSTGRESQL ---
            else:
                nombre_db = db_config['NAME']
                usuario = db_config['USER']
                password = db_config['PASSWORD']
                host = db_config.get('HOST', 'localhost')
                puerto = db_config.get('PORT', '5432')
                
                archivo_sql = f"{nombre_base}.sql"
                ruta_temp_db = os.path.join(carpeta_backups, archivo_sql)
                
                env = os.environ.copy()
                env['PGPASSWORD'] = password
                
                pg_dump = _obtener_pg_dump()
                comando = [
                    pg_dump, '-h', host, '-p', str(puerto),
                    '-U', usuario, '-F', 'p', '-d', nombre_db, '-f', ruta_temp_db
                ]
                
                resultado = subprocess.run(
                    comando, env=env, capture_output=True, text=True, timeout=300
                )
                if resultado.returncode != 0:
                    raise Exception(f"pg_dump falló: {resultado.stderr}")
                
                zipf.write(ruta_temp_db, arcname=archivo_sql)

            # --- AGREGAR CARPETA MEDIA SI APLICA ---
            if incluir_media and os.path.exists(settings.MEDIA_ROOT):
                for root, dirs, files in os.walk(settings.MEDIA_ROOT):
                    for file in files:
                        ruta_completa = os.path.join(root, file)
                        ruta_relativa = os.path.relpath(ruta_completa, settings.MEDIA_ROOT)
                        zipf.write(ruta_completa, arcname=os.path.join('media', ruta_relativa))

        # Limpiar SQL temporal si era de Postgres
        if ruta_temp_db and os.path.exists(ruta_temp_db):
            os.remove(ruta_temp_db)

        # Registrar en BD
        tamano_kb = os.path.getsize(ruta_zip) / 1024
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
        Respaldo.objects.create(
            nombre_archivo=archivo_zip,
            tipo=tipo,
            exito=False,
            mensaje_error=str(e),
            creado_por=creado_por,
            incluye_media=incluir_media,
        )
        if ruta_temp_db and os.path.exists(ruta_temp_db):
            os.remove(ruta_temp_db)
        if os.path.exists(ruta_zip):
            os.remove(ruta_zip)

        return {'exito': False, 'mensaje': str(e)}


def restaurar_respaldo(archivo_zip_path):
    """Restaura un respaldo ZIP dinámicamente según el motor de BD (SQLite / Postgres)"""
    db_config = settings.DATABASES['default']
    es_sqlite = 'sqlite3' in db_config['ENGINE']

    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            with zipfile.ZipFile(archivo_zip_path, 'r') as zipf:
                zipf.extractall(tmpdir)

            # --- CASO A: RESTAURAR SQLITE ---
            if es_sqlite:
                archivo_sqlite = None
                # Buscar cualquier archivo .sqlite3 dentro del zip extraído
                for file in os.listdir(tmpdir):
                    if file.endswith('.sqlite3') or file == 'db.sqlite3':
                        archivo_sqlite = os.path.join(tmpdir, file)
                        break

                if not archivo_sqlite:
                    raise Exception("El archivo ZIP no contiene una base de datos SQLite válida (.sqlite3).")

                db_dest = db_config['NAME']
                
                # Reemplazar la base de datos actual con la del respaldo
                shutil.copy2(archivo_sqlite, db_dest)

            # --- CASO B: RESTAURAR POSTGRESQL ---
            else:
                archivo_sql = None
                for file in os.listdir(tmpdir):
                    if file.endswith('.sql'):
                        archivo_sql = os.path.join(tmpdir, file)
                        break

                if not archivo_sql:
                    raise Exception("El ZIP no contiene un archivo .sql válido")

                nombre_db = db_config['NAME']
                usuario = db_config['USER']
                password = db_config['PASSWORD']
                host = db_config.get('HOST', 'localhost')
                puerto = db_config.get('PORT', '5432')

                env = os.environ.copy()
                env['PGPASSWORD'] = password
                psql = _obtener_pg_dump_psql()

                comando = [
                    psql, '-h', host, '-p', str(puerto),
                    '-U', usuario, '-d', nombre_db, '-f', archivo_sql
                ]

                resultado = subprocess.run(
                    comando, env=env, capture_output=True, text=True, timeout=600
                )
                if resultado.returncode != 0:
                    raise Exception(f"psql falló: {resultado.stderr}")

            # --- RESTAURAR CARPETA MEDIA SI EXISTE EN EL ZIP ---
            media_tmp = os.path.join(tmpdir, 'media')
            if os.path.exists(media_tmp):
                if os.path.exists(settings.MEDIA_ROOT):
                    shutil.rmtree(settings.MEDIA_ROOT)
                shutil.copytree(media_tmp, settings.MEDIA_ROOT)

        return {'exito': True, 'mensaje': 'Respaldo restaurado correctamente'}

    except Exception as e:
        return {'exito': False, 'mensaje': str(e)}


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