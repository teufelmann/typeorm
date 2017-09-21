import {QueryRunner} from "../../query-runner/QueryRunner";
import {ObjectLiteral} from "../../common/ObjectLiteral";
import {TransactionAlreadyStartedError} from "../../error/TransactionAlreadyStartedError";
import {TransactionNotStartedError} from "../../error/TransactionNotStartedError";
import {ColumnSchema} from "../../schema-builder/schema/ColumnSchema";
import {TableSchema} from "../../schema-builder/schema/TableSchema";
import {ForeignKeySchema} from "../../schema-builder/schema/ForeignKeySchema";
import {PrimaryKeySchema} from "../../schema-builder/schema/PrimaryKeySchema";
import {IndexSchema} from "../../schema-builder/schema/IndexSchema";
import {QueryRunnerAlreadyReleasedError} from "../../error/QueryRunnerAlreadyReleasedError";
import {SqlServerDriver} from "./SqlServerDriver";
import {Connection} from "../../connection/Connection";
import {ReadStream} from "../../platform/PlatformTools";
import {MssqlParameter} from "./MssqlParameter";
import {OrmUtils} from "../../util/OrmUtils";
import {EntityManager} from "../../entity-manager/EntityManager";
import {QueryFailedError} from "../../error/QueryFailedError";

/**
 * Runs queries on a single mysql database connection.
 */
export class SqlServerQueryRunner implements QueryRunner {

    // -------------------------------------------------------------------------
    // Public Implemented Properties
    // -------------------------------------------------------------------------

    /**
     * Database driver used by connection.
     */
    driver: SqlServerDriver;

    /**
     * Connection used by this query runner.
     */
    connection: Connection;

    /**
     * Isolated entity manager working only with current query runner.
     */
    manager: EntityManager;

    /**
     * Indicates if connection for this query runner is released.
     * Once its released, query runner cannot run queries anymore.
     */
    isReleased = false;

    /**
     * Indicates if transaction is in progress.
     */
    isTransactionActive = false;

    /**
     * Stores temporarily user data.
     * Useful for sharing data with subscribers.
     */
    data = {};

    // -------------------------------------------------------------------------
    // Protected Properties
    // -------------------------------------------------------------------------

    /**
     * Real database connection from a connection pool used to perform queries.
     */
    protected databaseConnection: any;

    /**
     * Last executed query in a transaction.
     * This is needed because in transaction mode mssql cannot execute parallel queries,
     * that's why we store last executed query promise to wait it when we execute next query.
     *
     * @see https://github.com/patriksimek/node-mssql/issues/491
     */
    protected queryResponsibilityChain: Promise<any>[] = [];

    /**
     * Indicates if special query runner mode in which sql queries won't be executed is enabled.
     */
    protected sqlMemoryMode: boolean = false;

    /**
     * Sql-s stored if "sql in memory" mode is enabled.
     */
    protected sqlsInMemory: string[] = [];

    /**
     * Mode in which query runner executes.
     * Used for replication.
     * If replication is not setup its value is ignored.
     */
    protected mode: "master"|"slave";

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(driver: SqlServerDriver, mode: "master"|"slave" = "master") {
        this.driver = driver;
        this.connection = driver.connection;
        this.mode = mode;
    }

    // -------------------------------------------------------------------------
    // Public Methods
    // -------------------------------------------------------------------------

    /**
     * Creates/uses database connection from the connection pool to perform further operations.
     * Returns obtained database connection.
     */
    connect(): Promise<any> {
        return Promise.resolve();
    }

    /**
     * Releases used database connection.
     * You cannot use query runner methods once its released.
     */
    release(): Promise<void> {
        this.isReleased = true;
        return Promise.resolve();
    }

    /**
     * Starts transaction.
     */
    async startTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        if (this.isTransactionActive)
            throw new TransactionAlreadyStartedError();

        return new Promise<void>(async (ok, fail) => {
            this.isTransactionActive = true;

            const pool = await (this.mode === "slave" ? this.driver.obtainSlaveConnection() : this.driver.obtainMasterConnection());
            this.databaseConnection = pool.transaction();
            this.databaseConnection.begin((err: any) => {
                if (err) {
                    this.isTransactionActive = false;
                    return fail(err);
                }
                ok();
            });
        });
    }

    /**
     * Commits transaction.
     * Error will be thrown if transaction was not started.
     */
    async commitTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();

        return new Promise<void>((ok, fail) => {
            this.databaseConnection.commit((err: any) => {
                if (err) return fail(err);
                this.isTransactionActive = false;
                this.databaseConnection = null;
                ok();
            });
        });
    }

    /**
     * Rollbacks transaction.
     * Error will be thrown if transaction was not started.
     */
    async rollbackTransaction(): Promise<void> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        if (!this.isTransactionActive)
            throw new TransactionNotStartedError();

        return new Promise<void>((ok, fail) => {
            this.databaseConnection.rollback((err: any) => {
                if (err) return fail(err);
                this.isTransactionActive = false;
                this.databaseConnection = null;
                ok();
            });
        });
    }

    protected mssqlParameterToNativeParameter(parameter: MssqlParameter): any {
        switch (this.driver.normalizeType({ type: parameter.type as any })) {
            case "bit":
                return this.driver.mssql.Bit;
            case "bigint":
                return this.driver.mssql.BigInt;
            case "decimal":
                return this.driver.mssql.Decimal(...parameter.params);
            case "float":
                return this.driver.mssql.Float;
            case "int":
                return this.driver.mssql.Int;
            case "money":
                return this.driver.mssql.Money;
            case "numeric":
                return this.driver.mssql.Numeric(...parameter.params);
            case "smallint":
                return this.driver.mssql.SmallInt;
            case "smallmoney":
                return this.driver.mssql.SmallMoney;
            case "real":
                return this.driver.mssql.Real;
            case "tinyint":
                return this.driver.mssql.TinyInt;
            case "char":
                return this.driver.mssql.Char(...parameter.params);
            case "nchar":
                return this.driver.mssql.NChar(...parameter.params);
            case "text":
                return this.driver.mssql.Text;
            case "ntext":
                return this.driver.mssql.Ntext;
            case "varchar":
                return this.driver.mssql.VarChar(...parameter.params);
            case "nvarchar":
                return this.driver.mssql.NVarChar(...parameter.params);
            case "xml":
                return this.driver.mssql.Xml;
            case "time":
                return this.driver.mssql.Time(...parameter.params);
            case "date":
                return this.driver.mssql.Date;
            case "datetime":
                return this.driver.mssql.DateTime;
            case "datetime2":
                return this.driver.mssql.DateTime2(...parameter.params);
            case "datetimeoffset":
                return this.driver.mssql.DateTimeOffset(...parameter.params);
            case "smalldatetime":
                return this.driver.mssql.SmallDateTime;
            case "uniqueidentifier":
                return this.driver.mssql.UniqueIdentifier;
            case "variant":
                return this.driver.mssql.Variant;
            case "binary":
                return this.driver.mssql.Binary;
            case "varbinary":
                return this.driver.mssql.VarBinary(...parameter.params);
            case "image":
                return this.driver.mssql.Image;
            case "udt":
                return this.driver.mssql.UDT;
            case "geography":
                return this.driver.mssql.Geography;
            case "geometry":
                return this.driver.mssql.Geometry;
        }
    }

    /**
     * Executes a given SQL query.
     */
    async query(query: string, parameters?: any[]): Promise<any> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        let waitingOkay: Function;
        const waitingPromise = new Promise((ok) => waitingOkay = ok);
        if (this.queryResponsibilityChain.length) {
            const otherWaitingPromises = [...this.queryResponsibilityChain];
            this.queryResponsibilityChain.push(waitingPromise);
            await Promise.all(otherWaitingPromises);
        }

        const promise = new Promise(async (ok, fail) => {
            try {
                this.driver.connection.logger.logQuery(query, parameters, this);
                const pool = await (this.mode === "slave" ? this.driver.obtainSlaveConnection() : this.driver.obtainMasterConnection());
                const request = new this.driver.mssql.Request(this.isTransactionActive ? this.databaseConnection : pool);
                if (parameters && parameters.length) {
                    parameters.forEach((parameter, index) => {
                        if (parameter instanceof MssqlParameter) {
                            const mssqlParameter = this.mssqlParameterToNativeParameter(parameter);
                            if (mssqlParameter) {
                                request.input(index, mssqlParameter, parameter.value);
                            } else {
                                request.input(index, parameter.value);
                            }
                        } else {
                            request.input(index, parameter);
                        }
                    });
                }
                const queryStartTime = +new Date();
                request.query(query, (err: any, result: any) => {

                    // log slow queries if maxQueryExecution time is set
                    const maxQueryExecutionTime = this.driver.connection.options.maxQueryExecutionTime;
                    const queryEndTime = +new Date();
                    const queryExecutionTime = queryEndTime - queryStartTime;
                    if (maxQueryExecutionTime && queryExecutionTime > maxQueryExecutionTime)
                        this.driver.connection.logger.logQuerySlow(queryExecutionTime, query, parameters, this);

                    const resolveChain = () => {
                        if (promiseIndex !== -1)
                            this.queryResponsibilityChain.splice(promiseIndex, 1);
                        if (waitingPromiseIndex !== -1)
                            this.queryResponsibilityChain.splice(waitingPromiseIndex, 1);
                        waitingOkay();
                    };

                    let promiseIndex = this.queryResponsibilityChain.indexOf(promise);
                    let waitingPromiseIndex = this.queryResponsibilityChain.indexOf(waitingPromise);
                    if (err) {
                        this.driver.connection.logger.logQueryError(err, query, parameters, this);
                        resolveChain();
                        return fail(new QueryFailedError(query, parameters, err));
                    }

                    ok(result.recordset);
                    resolveChain();
                });

            } catch (err) {
                fail(err);
            }
        });
        if (this.isTransactionActive)
            this.queryResponsibilityChain.push(promise);

        return promise;
    }

    /**
     * Returns raw data stream.
     */
    async stream(query: string, parameters?: any[], onEnd?: Function, onError?: Function): Promise<ReadStream> {
        if (this.isReleased)
            throw new QueryRunnerAlreadyReleasedError();

        let waitingOkay: Function;
        const waitingPromise = new Promise((ok) => waitingOkay = ok);
        if (this.queryResponsibilityChain.length) {
            const otherWaitingPromises = [...this.queryResponsibilityChain];
            this.queryResponsibilityChain.push(waitingPromise);
            await Promise.all(otherWaitingPromises);
        }

        const promise = new Promise<ReadStream>(async (ok, fail) => {

            this.driver.connection.logger.logQuery(query, parameters, this);
            const pool = await (this.mode === "slave" ? this.driver.obtainSlaveConnection() : this.driver.obtainMasterConnection());
            const request = new this.driver.mssql.Request(this.isTransactionActive ? this.databaseConnection : pool);
            request.stream = true;
            if (parameters && parameters.length) {
                parameters.forEach((parameter, index) => {
                    if (parameter instanceof MssqlParameter) {
                        request.input(index, this.mssqlParameterToNativeParameter(parameter), parameter.value);
                    } else {
                        request.input(index, parameter);
                    }
                });
            }
            request.query(query, (err: any, result: any) => {

                const resolveChain = () => {
                    if (promiseIndex !== -1)
                        this.queryResponsibilityChain.splice(promiseIndex, 1);
                    if (waitingPromiseIndex !== -1)
                        this.queryResponsibilityChain.splice(waitingPromiseIndex, 1);
                    waitingOkay();
                };

                let promiseIndex = this.queryResponsibilityChain.indexOf(promise);
                let waitingPromiseIndex = this.queryResponsibilityChain.indexOf(waitingPromise);
                if (err) {
                    this.driver.connection.logger.logQueryError(err, query, parameters, this);
                    resolveChain();
                    return fail(err);
                }

                ok(result.recordset);
                resolveChain();
            });
            if (onEnd) request.on("done", onEnd);
            if (onError) request.on("error", onError);
            ok(request as ReadStream);
        });
        if (this.isTransactionActive)
            this.queryResponsibilityChain.push(promise);

        return promise;
    }

    /**
     * Insert a new row with given values into the given table.
     * Returns value of the generated column if given and generate column exist in the table.
     */
    async insert(tablePath: string, keyValues: ObjectLiteral): Promise<any> {
        const keys = Object.keys(keyValues);
        const columns = keys.map(key => `"${key}"`).join(", ");
        const values = keys.map((key, index) => "@" + index).join(",");
        const generatedColumns = this.connection.hasMetadata(tablePath) ? this.connection.getMetadata(tablePath).generatedColumns : [];
        const generatedColumnNames = generatedColumns.map(generatedColumn => `INSERTED."${generatedColumn.databaseName}"`).join(", ");
        const generatedColumnSql = generatedColumns.length > 0 ? ` OUTPUT ${generatedColumnNames}` : "";
        const sql = columns.length > 0
            ? `INSERT INTO ${this.escapeTablePath(tablePath)}(${columns}) ${generatedColumnSql} VALUES (${values})`
            : `INSERT INTO ${this.escapeTablePath(tablePath)} ${generatedColumnSql} DEFAULT VALUES `;

        const parameters = this.driver.parametrizeMap(tablePath, keyValues);
        const parametersArray = Object.keys(parameters).map(key => parameters[key]);
        const result = await this.query(sql, parametersArray);
        const generatedMap = generatedColumns.reduce((map, column) => {
            const valueMap = column.createValueMap(result[0][column.databaseName]);
            return OrmUtils.mergeDeep(map, valueMap);
        }, {} as ObjectLiteral);

        return {
            result: result,
            generatedMap: Object.keys(generatedMap).length > 0 ? generatedMap : undefined
        };
    }

    /**
     * Updates rows that match given conditions in the given table.
     */
    async update(tablePath: string, valuesMap: ObjectLiteral, conditions: ObjectLiteral): Promise<void> {
        valuesMap = this.driver.parametrizeMap(tablePath, valuesMap);
        conditions = this.driver.parametrizeMap(tablePath, conditions);

        const conditionParams = Object.keys(conditions).map(key => conditions[key]);
        const updateParams = Object.keys(valuesMap).map(key => valuesMap[key]);
        const allParameters = updateParams.concat(conditionParams);

        const updateValues = this.parametrize(valuesMap).join(", ");
        const conditionString = this.parametrize(conditions, updateParams.length).join(" AND ");
        const sql = `UPDATE ${this.escapeTablePath(tablePath)} SET ${updateValues} ${conditionString ? (" WHERE " + conditionString) : ""}`;

        await this.query(sql, allParameters);
    }

    /**
     * Deletes from the given table by a given conditions.
     */
    async delete(tablePath: string, conditions: ObjectLiteral|string, maybeParameters?: any[]): Promise<void> {
        conditions = typeof conditions === "object" ? this.driver.parametrizeMap(tablePath, conditions) : conditions;
        const conditionString = typeof conditions === "string" ? conditions : this.parametrize(conditions).join(" AND ");
        const parameters = conditions instanceof Object ? Object.keys(conditions).map(key => (conditions as ObjectLiteral)[key]) : maybeParameters;

        const sql = `DELETE FROM ${this.escapeTablePath(tablePath)} WHERE ${conditionString}`;
        await this.query(sql, parameters);
    }

    /**
     * Inserts rows into the closure table.
     */
    async insertIntoClosureTable(tablePath: string, newEntityId: any, parentId: any, hasLevel: boolean): Promise<number> {
        let sql = "";
        if (hasLevel) { // todo: escape all parameters there
            sql = `INSERT INTO ${this.escapeTablePath(tablePath)}("ancestor", "descendant", "level") ` +
                `SELECT "ancestor", ${newEntityId}, "level" + 1 FROM ${this.escapeTablePath(tablePath)} WHERE "descendant" = ${parentId} ` +
                `UNION ALL SELECT ${newEntityId}, ${newEntityId}, 1`;
        } else {
            sql = `INSERT INTO ${this.escapeTablePath(tablePath)}("ancestor", "descendant") ` +
                `SELECT "ancestor", ${newEntityId} FROM ${this.escapeTablePath(tablePath)} WHERE "descendant" = ${parentId} ` +
                `UNION ALL SELECT ${newEntityId}, ${newEntityId}`;
        }
        await this.query(sql);
        if (hasLevel) {
            const results: ObjectLiteral[] = await this.query(`SELECT MAX(level) as level FROM ${this.escapeTablePath(tablePath)} WHERE descendant = ${parentId}`);
            return results && results[0] && results[0]["level"] ? parseInt(results[0]["level"]) + 1 : 1;
        } else {
            return -1;
        }
    }

    /**
     * Loads given table's data from the database.
     */
    async getTable(tablePath: string): Promise<TableSchema|undefined> {
        const tableSchemas = await this.getTables([tablePath]);
        return tableSchemas.length > 0 ? tableSchemas[0] : undefined;
    }

    /**
     * Loads all tables (with given names) from the database and creates a TableSchema from them.
     */
    async getTables(tablePaths: string[]): Promise<TableSchema[]> {

        // if no tables given then no need to proceed
        if (!tablePaths || !tablePaths.length)
            return [];

        const tableNames = tablePaths.map(tablePath => {
            if (tablePath.split(".").length === 3) {
                return tablePath.split(".")[2];
            } else if (tablePath.split(".").length === 2) {
                return tablePath.split(".")[1];
            } else {
                return tablePath;
            }
        });

        const schemaNames = tablePaths
            .filter(tablePath => tablePath.indexOf(".") !== -1)
            .map(tablePath => {
                return tablePath.split(".").length === 3 ? tablePath.split(".")[1] : tablePath.split(".")[0];
            });
        schemaNames.push(this.driver.options.schema || "SCHEMA_NAME()");

        // const dbNames = ["secondDB", "test"];
        const dbNames = tablePaths
            .filter(tablePath => tablePath.split(".").length === 3)
            .map(tablePath => {
                return tablePath.split(".")[0];
            });
        if (this.driver.database)
            dbNames.push(this.driver.database);

        // load tables, columns, indices and foreign keys
        const schemaNamesString = schemaNames.map(name => {
            return name === "SCHEMA_NAME()" ? name : "'" + name + "'";
        }).join(", ");
        const tableNamesString = tableNames.map(name => "'" + name + "'").join(", ");

        const tablesSql = dbNames.map(dbName => {
            return `SELECT * FROM ${dbName}.INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME IN (${tableNamesString}) AND TABLE_SCHEMA IN (${schemaNamesString})`;
        }).join(" UNION ALL ");

        const columnsSql = dbNames.map(dbName => {
            return `SELECT * FROM ${dbName}.INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA IN (${schemaNamesString})`;
        }).join(" UNION ALL ");

        const constraintsSql = dbNames.map(dbName => {
            return `SELECT columnUsages.*, tableConstraints.CONSTRAINT_TYPE FROM ${dbName}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE columnUsages ` +
                `LEFT JOIN ${dbName}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tableConstraints ON tableConstraints.CONSTRAINT_NAME = columnUsages.CONSTRAINT_NAME ` +
                `WHERE columnUsages.TABLE_SCHEMA IN (${schemaNamesString}) AND tableConstraints.TABLE_SCHEMA IN (${schemaNamesString})`;
        }).join(" UNION ALL ");

        const identityColumnsSql = dbNames.map(dbName => {
            return  `SELECT COLUMN_NAME, TABLE_NAME FROM ${dbName}.INFORMATION_SCHEMA.COLUMNS WHERE COLUMNPROPERTY(object_id(TABLE_SCHEMA + '.' + TABLE_NAME), COLUMN_NAME, 'IsIdentity') = 1 AND TABLE_SCHEMA IN (${schemaNamesString})`;
        }).join(" UNION ALL ");

        const indicesSql = dbNames.map(dbName => {
            return `
            SELECT TABLE_NAME = t.name, INDEX_NAME = ind.name, IndexId = ind.index_id, ColumnId = ic.index_column_id, 
                    COLUMN_NAME = col.name, IS_UNIQUE = ind.is_unique, ind.*, ic.*, col.* 
                    FROM ${dbName}.sys.indexes ind 
                    INNER JOIN ${dbName}.sys.index_columns ic ON ind.object_id = ic.object_id and ind.index_id = ic.index_id
                    INNER JOIN ${dbName}.sys.columns col ON ic.object_id = col.object_id and ic.column_id = col.column_id 
                    INNER JOIN ${dbName}.sys.tables t ON ind.object_id = t.object_id WHERE ind.is_primary_key = 0 
                    AND ind.is_unique_constraint = 0 AND t.is_ms_shipped = 0`;
        }).join(" UNION ALL ");
        const [dbTables, dbColumns, dbConstraints, dbIdentityColumns, dbIndices]: ObjectLiteral[][] = await Promise.all([
            this.query(tablesSql),
            this.query(columnsSql),
            this.query(constraintsSql),
            this.query(identityColumnsSql),
            this.query(indicesSql),
        ]);

        // if tables were not found in the db, no need to proceed
        if (!dbTables.length)
            return [];

        // create table schemas for loaded tables
        return Promise.all(dbTables.map(async dbTable => {
            const tableSchema = new TableSchema(dbTable["TABLE_NAME"]);

            tableSchema.database = dbTable["TABLE_CATALOG"];
            tableSchema.schema = dbTable["TABLE_SCHEMA"];

            // create column schemas from the loaded columns
            tableSchema.columns = dbColumns
                .filter(dbColumn => dbColumn["TABLE_NAME"] === tableSchema.name)
                .map(dbColumn => {
                    const isPrimary = !!dbConstraints.find(dbConstraint => {
                        return  dbConstraint["TABLE_NAME"] === tableSchema.name &&
                                dbConstraint["COLUMN_NAME"] === dbColumn["COLUMN_NAME"] &&
                                dbConstraint["CONSTRAINT_TYPE"] === "PRIMARY KEY";
                    });
                    const isGenerated = !!dbIdentityColumns.find(column => {
                        return  column["TABLE_NAME"] === tableSchema.name &&
                                column["COLUMN_NAME"] === dbColumn["COLUMN_NAME"];
                    });
                    const isUnique = !!dbConstraints.find(dbConstraint => {
                        return  dbConstraint["TABLE_NAME"] === tableSchema.name &&
                                dbConstraint["COLUMN_NAME"] === dbColumn["COLUMN_NAME"] &&
                                dbConstraint["CONSTRAINT_TYPE"] === "UNIQUE";
                    });

                    const columnSchema = new ColumnSchema();
                    columnSchema.name = dbColumn["COLUMN_NAME"];
                    columnSchema.type = dbColumn["DATA_TYPE"].toLowerCase();

                    columnSchema.length = dbColumn["CHARACTER_MAXIMUM_LENGTH"] ? dbColumn["CHARACTER_MAXIMUM_LENGTH"].toString() : "";
                    if (columnSchema.length === "-1")
                        columnSchema.length = "MAX";

                    columnSchema.precision = dbColumn["NUMERIC_PRECISION"];
                    columnSchema.scale = dbColumn["NUMERIC_SCALE"];
                    columnSchema.default = dbColumn["COLUMN_DEFAULT"] !== null && dbColumn["COLUMN_DEFAULT"] !== undefined ? dbColumn["COLUMN_DEFAULT"] : undefined;
                    columnSchema.isNullable = dbColumn["IS_NULLABLE"] === "YES";
                    columnSchema.isPrimary = isPrimary;
                    columnSchema.isGenerated = isGenerated;
                    columnSchema.isUnique = isUnique;
                    columnSchema.charset = dbColumn["CHARACTER_SET_NAME"];
                    columnSchema.collation = dbColumn["COLLATION_NAME"];
                    columnSchema.comment = ""; // todo: less priority, implement this later

                    if (columnSchema.type === "datetime2" || columnSchema.type === "time" || columnSchema.type === "datetimeoffset") {
                        columnSchema.precision = dbColumn["DATETIME_PRECISION"];
                    }

                    return columnSchema;
                });

            // create primary key schema
            tableSchema.primaryKeys = dbConstraints
                .filter(dbConstraint => {
                    return  dbConstraint["TABLE_NAME"] === tableSchema.name &&
                            dbConstraint["CONSTRAINT_TYPE"] === "PRIMARY KEY";
                })
                .map(keyColumnUsage => {
                    return new PrimaryKeySchema(keyColumnUsage["CONSTRAINT_NAME"], keyColumnUsage["COLUMN_NAME"]);
                });

            // create foreign key schemas from the loaded indices
            tableSchema.foreignKeys = dbConstraints
                .filter(dbConstraint => {
                    return  dbConstraint["TABLE_NAME"] === tableSchema.name &&
                            dbConstraint["CONSTRAINT_TYPE"] === "FOREIGN KEY";
                })
                .map(dbConstraint => new ForeignKeySchema(dbConstraint["CONSTRAINT_NAME"], [], [], "", "")); // todo: fix missing params

            // create index schemas from the loaded indices
            tableSchema.indices = dbIndices
                .filter(dbIndex => {
                    return  dbIndex["TABLE_NAME"] === tableSchema.name &&
                            (!tableSchema.foreignKeys.find(foreignKey => foreignKey.name === dbIndex["INDEX_NAME"])) &&
                            (!tableSchema.primaryKeys.find(primaryKey => primaryKey.name === dbIndex["INDEX_NAME"]));
                })
                .map(dbIndex => dbIndex["INDEX_NAME"])
                .filter((value, index, self) => self.indexOf(value) === index) // unqiue
                .map(dbIndexName => {
                    const columnNames = dbIndices
                        .filter(dbIndex => dbIndex["TABLE_NAME"] === tableSchema.name && dbIndex["INDEX_NAME"] === dbIndexName)
                        .map(dbIndex => dbIndex["COLUMN_NAME"]);

                    const isUnique = !!dbIndices.find(dbIndex => dbIndex["TABLE_NAME"] === tableSchema.name && dbIndex["INDEX_NAME"] === dbIndexName && dbIndex["IS_UNIQUE"] === true);
                    return new IndexSchema(dbTable["TABLE_NAME"], dbIndexName, columnNames,  isUnique);
                });

            return tableSchema;
        }));
    }

    /**
     * Checks if table with the given name exist in the database.
     */
    async hasTable(tablePath: string): Promise<boolean> {
        const parsedTablePath = this.parseTablePath(tablePath);
        const sql = `SELECT * FROM ${parsedTablePath.database}.INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${parsedTablePath.schema}' AND TABLE_SCHEMA = '${parsedTablePath.tableName}'`;
        const result = await this.query(sql);
        return result.length ? true : false;
    }

    /**
     * Creates a schema if it's not created.
     */
    createSchema(schemas: string[]): Promise<void[]> {
        if (this.driver.options.schema)
            schemas.push(this.driver.options.schema);
        return Promise.all(schemas.map(schema => {
            const query = `IF NOT EXISTS (SELECT schema_name FROM information_schema.schemata WHERE schema_name = '${schema}') 
BEGIN EXEC sp_executesql N'CREATE SCHEMA ${schema}' END`;
            return this.query(query);
        }));
    }

    /**
     * Creates a new table from the given table metadata and column metadatas.
     */
    async createTable(table: TableSchema): Promise<void> {
        const columnDefinitions = table.columns.map(column => this.buildCreateColumnSql(table.name, column, false, true)).join(", ");
        let sql = `CREATE TABLE ${this.escapeTablePath(table)} (${columnDefinitions}`;
        sql += table.columns
            .filter(column => column.isUnique)
            .map(column => {
                let constraintName = `${table.name}_${column.name}`;
                const schema = table.schema || this.driver.options.schema;
                if (schema)
                    constraintName = `${schema}_` + constraintName;

                return `, CONSTRAINT "uk_${constraintName}" UNIQUE ("${column.name}")`;
            }).join(" ");
        const primaryKeyColumns = table.columns.filter(column => column.isPrimary);
        if (primaryKeyColumns.length > 0)
            sql += `, PRIMARY KEY(${primaryKeyColumns.map(column => `"${column.name}"`).join(", ")})`;
        sql += `)`;
        await this.query(sql);
    }

    /**
     * Drops the table.
     */
    async dropTable(tablePath: string): Promise<void> {
        await this.query(`DROP TABLE ${this.escapeTablePath(tablePath)}`);
    }

    /**
     * Checks if column with the given name exist in the given table.
     */
    async hasColumn(tablePath: string, columnName: string): Promise<boolean> {
        const parsedTablePath = this.parseTablePath(tablePath);
        const sql = `SELECT * FROM ${parsedTablePath.database}.INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = '${parsedTablePath.tableName}' AND COLUMN_NAME = '${columnName}' AND TABLE_SCHEMA = '${parsedTablePath.schema}'`;
        const result = await this.query(sql);
        return result.length ? true : false;
    }

    /**
     * Creates a new column from the column schema in the table.
     */
    async addColumn(tableSchemaOrPath: TableSchema|string, column: ColumnSchema): Promise<void> {
        const tableName = tableSchemaOrPath instanceof TableSchema ? tableSchemaOrPath.name : this.parseTablePath(tableSchemaOrPath).tableName;
        const sql = `ALTER TABLE ${this.escapeTablePath(tableSchemaOrPath)} ADD ${this.buildCreateColumnSql(tableName, column, false, true)}`;
        return this.query(sql);
    }

    /**
     * Creates a new columns from the column schema in the table.
     */
    async addColumns(tableSchemaOrName: TableSchema|string, columns: ColumnSchema[]): Promise<void> {
        const queries = columns.map(column => this.addColumn(tableSchemaOrName as any, column));
        await Promise.all(queries);
    }

    /**
     * Renames column in the given table.
     */
    async renameColumn(tableSchemaOrName: TableSchema|string, oldColumnSchemaOrName: ColumnSchema|string, newColumnSchemaOrName: ColumnSchema|string): Promise<void> {
        let tableSchema: TableSchema|undefined = undefined;
        if (tableSchemaOrName instanceof TableSchema) {
            tableSchema = tableSchemaOrName;
        } else {
            tableSchema = await this.getTable(tableSchemaOrName);
        }

        if (!tableSchema)
            throw new Error(`Table ${tableSchemaOrName} was not found.`);

        let oldColumn: ColumnSchema|undefined = undefined;
        if (oldColumnSchemaOrName instanceof ColumnSchema) {
            oldColumn = oldColumnSchemaOrName;
        } else {
            oldColumn = tableSchema.columns.find(column => column.name === oldColumnSchemaOrName);
        }

        if (!oldColumn)
            throw new Error(`Column "${oldColumnSchemaOrName}" was not found in the "${tableSchemaOrName}" table.`);

        let newColumn: ColumnSchema|undefined = undefined;
        if (newColumnSchemaOrName instanceof ColumnSchema) {
            newColumn = newColumnSchemaOrName;
        } else {
            newColumn = oldColumn.clone();
            newColumn.name = newColumnSchemaOrName;
        }

        return this.changeColumn(tableSchema, oldColumn, newColumn);
    }

    /**
     * Changes a column in the table.
     */
    async changeColumn(tableSchemaOrName: TableSchema|string, oldColumnSchemaOrName: ColumnSchema|string, newColumn: ColumnSchema): Promise<void> {

        let tableSchema: TableSchema|undefined = undefined;
        if (tableSchemaOrName instanceof TableSchema) {
            tableSchema = tableSchemaOrName;
        } else {
            tableSchema = await this.getTable(tableSchemaOrName);
        }

        if (!tableSchema)
            throw new Error(`Table ${tableSchemaOrName} was not found.`);

        let oldColumn: ColumnSchema|undefined = undefined;
        if (oldColumnSchemaOrName instanceof ColumnSchema) {
            oldColumn = oldColumnSchemaOrName;
        } else {
            oldColumn = tableSchema.columns.find(column => column.name === oldColumnSchemaOrName);
        }

        if (!oldColumn)
            throw new Error(`Column "${oldColumnSchemaOrName}" was not found in the "${tableSchemaOrName}" table.`);

        // to update an identy column we have to drop column and recreate it again
        if (newColumn.isGenerated !== oldColumn.isGenerated) {
            await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} DROP COLUMN "${newColumn.name}"`);
            await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} ADD ${this.buildCreateColumnSql(tableSchema.name, newColumn, false, false)}`);
        }

        const sql = `ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} ALTER COLUMN ${this.buildCreateColumnSql(tableSchema.name, newColumn, true, false)}`; // todo: CHANGE OR MODIFY COLUMN ????
        await this.query(sql);

        if (newColumn.isUnique !== oldColumn.isUnique) {
            if (newColumn.isUnique === true) {
                await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} ADD CONSTRAINT "uk_${tableSchema.name}_${newColumn.name}" UNIQUE ("${newColumn.name}")`);

            } else if (newColumn.isUnique === false) {
                await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} DROP CONSTRAINT "uk_${tableSchema.name}_${newColumn.name}"`);

            }
        }
        if (newColumn.default !== oldColumn.default) {
            if (newColumn.default !== null && newColumn.default !== undefined) {
                await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} DROP CONSTRAINT "df_${tableSchema.name}_${newColumn.name}"`);
                await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} ADD CONSTRAINT "df_${tableSchema.name}_${newColumn.name}" DEFAULT ${newColumn.default} FOR "${newColumn.name}"`);

            } else if (oldColumn.default !== null && oldColumn.default !== undefined) {
                await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchemaOrName)} DROP CONSTRAINT "df_${tableSchema.name}_${newColumn.name}"`);

            }
        }
    }

    /**
     * Changes a column in the table.
     */
    async changeColumns(tableSchema: TableSchema, changedColumns: { newColumn: ColumnSchema, oldColumn: ColumnSchema }[]): Promise<void> {
        const updatePromises = changedColumns.map(async changedColumn => {
            return this.changeColumn(tableSchema, changedColumn.oldColumn, changedColumn.newColumn);
        });

        await Promise.all(updatePromises);
    }

    /**
     * Drops column in the table.
     */
    async dropColumn(tableSchema: TableSchema, column: ColumnSchema): Promise<void> {
        if (column.default)
            await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchema)} DROP CONSTRAINT "df_${tableSchema.name}_${column.name}"`);
        await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchema)} DROP COLUMN "${column.name}"`);
    }

    /**
     * Drops the columns in the table.
     */
    async dropColumns(tableSchema: TableSchema, columns: ColumnSchema[]): Promise<void> {
        const dropPromises = columns.map(column => this.dropColumn(tableSchema, column));
        await Promise.all(dropPromises);
    }

    /**
     * Updates table's primary keys.
     */
    async updatePrimaryKeys(tableSchema: TableSchema): Promise<void> {
        const schema = tableSchema.schema || "SCHEMA_NAME()";
        const database = tableSchema.database || this.driver.database;
        const oldPrimaryKeySql = `SELECT columnUsages.*, tableConstraints.CONSTRAINT_TYPE FROM ${database}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE columnUsages
LEFT JOIN ${database}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tableConstraints ON tableConstraints.CONSTRAINT_NAME = columnUsages.CONSTRAINT_NAME AND tableConstraints.CONSTRAINT_TYPE = 'PRIMARY KEY'
WHERE tableConstraints.TABLE_CATALOG = '${database}' AND columnUsages.TABLE_SCHEMA = '${schema}' AND tableConstraints.TABLE_SCHEMA = '${schema}'`;
        const oldPrimaryKey = await this.query(oldPrimaryKeySql);
        if (oldPrimaryKey.length > 0)
            await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchema)} DROP CONSTRAINT "${oldPrimaryKey[0]["CONSTRAINT_NAME"]}"`);

        const primaryColumnNames = tableSchema.primaryKeys.map(primaryKey => `"` + primaryKey.columnName + `"`);
        if (primaryColumnNames.length > 0)
            await this.query(`ALTER TABLE ${this.escapeTablePath(tableSchema)} ADD PRIMARY KEY (${primaryColumnNames.join(", ")})`);
    }

    /**
     * Creates a new foreign key.
     */
    async createForeignKey(tableSchemaOrPath: TableSchema|string, foreignKey: ForeignKeySchema): Promise<void> {
        const columnNames = foreignKey.columnNames.map(column => `"` + column + `"`).join(", ");
        const referencedColumnNames = foreignKey.referencedColumnNames.map(column => `"` + column + `"`).join(",");
        let sql = `ALTER TABLE ${this.escapeTablePath(tableSchemaOrPath)} ADD CONSTRAINT "${foreignKey.name}" ` +
            `FOREIGN KEY (${columnNames}) ` +
            `REFERENCES ${this.escapeTablePath(foreignKey.referencedTablePath)}(${referencedColumnNames})`;
        if (foreignKey.onDelete) sql += " ON DELETE " + foreignKey.onDelete;
        return this.query(sql);
    }

    /**
     * Creates a new foreign keys.
     */
    async createForeignKeys(tableSchemaOrName: TableSchema|string, foreignKeys: ForeignKeySchema[]): Promise<void> {
        const promises = foreignKeys.map(foreignKey => this.createForeignKey(tableSchemaOrName as any, foreignKey));
        await Promise.all(promises);
    }

    /**
     * Drops a foreign key from the table.
     */
    async dropForeignKey(tableSchemaOrPath: TableSchema|string, foreignKey: ForeignKeySchema): Promise<void> {
        const sql = `ALTER TABLE ${this.escapeTablePath(tableSchemaOrPath)} DROP CONSTRAINT "${foreignKey.name}"`;
        return this.query(sql);
    }

    /**
     * Drops a foreign keys from the table.
     */
    async dropForeignKeys(tableSchemaOrName: TableSchema|string, foreignKeys: ForeignKeySchema[]): Promise<void> {
        const promises = foreignKeys.map(foreignKey => this.dropForeignKey(tableSchemaOrName as any, foreignKey));
        await Promise.all(promises);
    }

    /**
     * Creates a new index.
     */
    async createIndex(tablePath: string, index: IndexSchema): Promise<void> {
        const columns = index.columnNames.map(columnName => `"${columnName}"`).join(", ");
        const sql = `CREATE ${index.isUnique ? "UNIQUE " : ""}INDEX "${index.name}" ON ${this.escapeTablePath(tablePath)}(${columns})`;
        await this.query(sql);
    }

    /**
     * Drops an index from the table.
     */
    async dropIndex(tableSchemeOrName: TableSchema|string, indexName: string): Promise<void> {
        const sql = `DROP INDEX "${indexName}" ON ${this.escapeTablePath(tableSchemeOrName)}`;
        await this.query(sql);
    }

    /**
     * Truncates table.
     */
    async truncate(tablePath: string): Promise<void> {
        await this.query(`TRUNCATE TABLE ${this.escapeTablePath(tablePath)}`);
    }

    /**
     * Removes all tables from the currently connected database.
     */
    async clearDatabase(tableSchemas?: string[], database?: string): Promise<void> {
        if (!tableSchemas)
            tableSchemas = [];
        tableSchemas.push(this.driver.options.schema || "SCHEMA_NAME()");
        const schemaNamesString = tableSchemas.map(name => {
            return name === "SCHEMA_NAME()" ? name : "'" + name + "'";
        }).join(", ");

        await this.startTransaction();
        try {
            let allTablesSql = `SELECT * FROM ${database}.INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA IN (${schemaNamesString})`;
            const allTablesResults: ObjectLiteral[] = await this.query(allTablesSql);
            await Promise.all(allTablesResults.map(async tablesResult => {
                const dropForeignKeySql = `SELECT 'ALTER TABLE ' +  OBJECT_SCHEMA_NAME(parent_object_id) + '.[' + OBJECT_NAME(parent_object_id) + '] DROP CONSTRAINT ' + name as query FROM ${database}.sys.foreign_keys WHERE referenced_object_id = object_id('"${tablesResult["TABLE_SCHEMA"]}"."${tablesResult["TABLE_NAME"]}"')`;
                const dropFkQueries: ObjectLiteral[] = await this.query(dropForeignKeySql);
                return Promise.all(dropFkQueries.map(result => result["query"]).map(dropQuery => {
                    return this.query(dropQuery);
                }));
            }));
            await Promise.all(allTablesResults.map(tablesResult => {
                const dropTableSql = `DROP TABLE "${tablesResult["TABLE_SCHEMA"]}"."${tablesResult["TABLE_NAME"]}"`;
                return this.query(dropTableSql);
            }));

            await this.commitTransaction();

        } catch (error) {
            try { // we throw original error even if rollback thrown an error
                await this.rollbackTransaction();
            } catch (rollbackError) { }
            throw error;
        }
    }

    /**
     * Enables special query runner mode in which sql queries won't be executed,
     * instead they will be memorized into a special variable inside query runner.
     * You can get memorized sql using getMemorySql() method.
     */
    enableSqlMemory(): void {
        this.sqlMemoryMode = true;
    }

    /**
     * Disables special query runner mode in which sql queries won't be executed
     * started by calling enableSqlMemory() method.
     *
     * Previously memorized sql will be flushed.
     */
    disableSqlMemory(): void {
        this.sqlsInMemory = [];
        this.sqlMemoryMode = false;
    }

    /**
     * Gets sql stored in the memory. Parameters in the sql are already replaced.
     */
    getMemorySql(): (string|{ up: string, down: string })[] {
        return this.sqlsInMemory;
    }

    // -------------------------------------------------------------------------
    // Protected Methods
    // -------------------------------------------------------------------------

    /**
     * Escapes given table path.
     */
    protected escapeTablePath(tableSchemaOrPath: TableSchema|string, disableEscape?: boolean): string {
        let tablePath;
        if (tableSchemaOrPath instanceof TableSchema) {
            const schema = tableSchemaOrPath.schema || this.driver.options.schema;
            if (schema) {
                tablePath = `${schema}.${tableSchemaOrPath.name}`;
                if (tableSchemaOrPath.database)
                    tablePath = `${tableSchemaOrPath.database}.${tablePath}`;
            } else {
                tablePath = tableSchemaOrPath.name;
            }
        } else {
            tablePath = tableSchemaOrPath.indexOf(".") === -1 && this.driver.options.schema ? this.driver.options.schema + "." + tableSchemaOrPath : tableSchemaOrPath;
        }

        return tablePath.split(".").map(i => {
            return disableEscape ? i : `"${i}"`;
        }).join(".");
    }

    protected parseTablePath(tablePath: string): any {
        if (tablePath.split(".").length === 3) {
            return {
                database:  "'" + tablePath.split(".")[0] + "'",
                schema: "'" + tablePath.split(".")[1] + "'",
                tableName: "'" + tablePath.split(".")[2] + "'"
            };
        } else if (tablePath.split(".").length === 2) {
            return {
                database:  this.driver.options.database,
                schema: "'" + tablePath.split(".")[1] + "'",
                tableName: "'" + tablePath.split(".")[2] + "'"
            };
        } else {
            return {
                database:  this.driver.options.database,
                schema: this.driver.options.schema ? "'" + this.driver.options.schema + "'" : "SCHEMA_NAME()",
                tableName: tablePath
            };
        }
    }

    /**
     * Parametrizes given object of values. Used to create column=value queries.
     */
    protected parametrize(objectLiteral: ObjectLiteral, startFrom: number = 0): string[] {
        return Object.keys(objectLiteral).map((key, index) => {
            return `"${key}"` + "=@" + (startFrom + index);
        });
    }

    /**
     * Builds a query for create column.
     */
    protected buildCreateColumnSql(tableName: string, column: ColumnSchema, skipIdentity: boolean, createDefault: boolean) {
        let c = `"${column.name}" ${this.connection.driver.createFullType(column)}`;
        if (column.collation)
            c += " COLLATE " + column.collation;
        if (column.isNullable !== true)
            c += " NOT NULL";
        if (column.isGenerated === true && column.generationStrategy === "increment" && !skipIdentity) // don't use skipPrimary here since updates can update already exist primary without auto inc.
            c += " IDENTITY(1,1)";
        // if (column.isPrimary === true && !skipPrimary)
        //     c += " PRIMARY KEY";
        if (column.comment)
            c += " COMMENT '" + column.comment + "'";
        if (createDefault) {
            if (column.default !== undefined && column.default !== null) {
                c += ` CONSTRAINT "df_${tableName}_${column.name}" DEFAULT ${column.default}`;
            }
        }
        return c;
    }


}