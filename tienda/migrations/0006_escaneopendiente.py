# Generado manualmente para el "buzón" del lector de código de barras por celular

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tienda', '0005_productos_codigo_barra'),
    ]

    operations = [
        migrations.CreateModel(
            name='EscaneoPendiente',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('ultimo_codigo', models.CharField(blank=True, max_length=64, null=True)),
                ('recibido_en', models.DateTimeField(blank=True, null=True)),
            ],
            options={
                'db_table': 'EscaneoPendiente',
            },
        ),
    ]
