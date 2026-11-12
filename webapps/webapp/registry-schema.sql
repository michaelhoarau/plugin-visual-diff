-- Optional reference: the webapp automatically initializes an empty Snowflake
-- dataset and creates its table. Running this script manually is not required.
-- Choose the database/schema/table name appropriate to your DSS connection.
-- Uses a standard Snowflake table; a hybrid table or enforced key is not required.
CREATE TABLE VISUAL_FLOW_DIFF_REGISTRY (
    RECORD_KEY VARCHAR(64) NOT NULL,
    INSTANCE_URL VARCHAR NOT NULL,
    SOURCE_PROJECT_KEY VARCHAR NOT NULL,
    COMMIT_SHA VARCHAR(40) NOT NULL,
    GENERATED_PROJECT_KEY VARCHAR,
    BRANCH_NAME VARCHAR NOT NULL,
    PREPARATION_STATUS VARCHAR NOT NULL,
    VERIFIED_HEAD VARCHAR(40),
    CREATED_AT DOUBLE NOT NULL,
    UPDATED_AT DOUBLE NOT NULL,
    RECORD_JSON VARCHAR NOT NULL
);
-- CREATED_AT/UPDATED_AT are Unix epoch seconds, retaining fractional seconds.
-- The DSS backend's connection role needs SELECT, INSERT, UPDATE on this table,
-- plus the usual database/schema/warehouse USAGE privileges.
-- Cleanup additionally requires DELETE on the registry table.
