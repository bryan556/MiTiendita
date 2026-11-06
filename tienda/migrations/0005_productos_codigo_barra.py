# Generado manualmente para agregar el campo de código de barras a Productos

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tienda', '0004_cajadiaria_usuario'),
    ]

    operations = [
        migrations.AddField(
            model_name='productos',
            name='codigo_barra',
            field=models.CharField(blank=True, db_column='CodigoBarra', max_length=64, null=True, unique=True),
        ),
    ]
