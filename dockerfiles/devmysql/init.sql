CREATE USER '6529backend'@'%' identified with mysql_native_password by 'backend9256';
CREATE DATABASE OM6529;
GRANT ALL PRIVILEGES ON OM6529.* TO '6529backend';
FLUSH PRIVILEGES;