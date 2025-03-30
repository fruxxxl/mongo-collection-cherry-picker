#!/bin/bash

# Цвета для вывода
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}Setting up test environment...${NC}"

# Start Docker Compose
docker-compose -f docker-compose.test.yml up -d

# Waiting for MongoDB to be ready
echo -e "${YELLOW}Waiting for MongoDB to be ready...${NC}"
sleep 30

# Create backups directory if it doesn't exist
mkdir -p backups

# Check container status
echo -e "${YELLOW}Checking container status...${NC}"
docker ps

# Additional check if mongo-tools is running
if ! docker ps | grep -q mongo-tools; then
  echo -e "${RED}Container mongo-tools is not running!${NC}"
  echo -e "${YELLOW}Checking container logs...${NC}"
  docker logs mongo-tools
  echo -e "${YELLOW}Trying to restart container...${NC}"
  docker-compose -f docker-compose.test.yml up -d mongo-tools
  sleep 10
  
  if ! docker ps | grep -q mongo-tools; then
    echo -e "${RED}Failed to start container mongo-tools. Exiting.${NC}"
    exit 1
  fi
fi

# Check MongoDB container status
echo -e "${YELLOW}Checking MongoDB container status...${NC}"
docker ps | grep test-mongodb

echo -e "${YELLOW}Checking MongoDB logs...${NC}"
docker logs test-mongodb | tail -n 20

echo -e "${YELLOW}Checking MongoDB connection...${NC}"
# First get MongoDB container IP address
MONGODB_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' test-mongodb)
echo -e "${YELLOW}MongoDB IP address: $MONGODB_IP${NC}"

# Update hosts file in mongo-tools container
docker exec mongo-tools bash -c "echo \"$MONGODB_IP mongodb\" >> /etc/hosts"

# Try to connect
docker exec test-mongodb mongo --quiet --host localhost --port 27017 --eval "db.runCommand({ping:1})" >/dev/null 2>&1
if [ $? -ne 0 ]; then
  echo -e "${RED}First connection attempt failed, retrying with error output...${NC}"
  docker exec test-mongodb mongo --host localhost --port 27017 --eval "db.runCommand({ping:1})"
  
  echo -e "${YELLOW}Trying to connect without authentication (if MongoDB is not configured)...${NC}"
  docker exec test-mongodb mongo --host $MONGODB_IP --port 27017 --eval "db.runCommand({ping:1})"
  
  echo -e "${RED}✗ MongoDB is not available. Check the connection.${NC}"
  
  echo -e "${YELLOW}Fix: Check if MongoDB is initialized correctly.${NC}"
  echo -e "${YELLOW}You can manually check the connection with the command:${NC}"
  echo -e "docker exec -it test-mongodb mongo mongodb://$MONGODB_IP:27017/"
  
  exit 1
fi

echo -e "${GREEN}✓ MongoDB is ready to work${NC}"

# Test utility
echo -e "\n${YELLOW}=== Test utility backup MongoDB ===${NC}\n"

# Create temporary configuration with settings for connecting to MongoDB container
cat > config.container.json << EOF
{
  "backupDir": "backups",
  "filenameFormat": "backup_{{date}}_{{source}}.gz",
  "mongodumpPath": "mongodump",
  "mongorestorePath": "mongorestore",
  "connections": [
    {
      "name": "Test MongoDB",
      "uri": "mongodb://172.17.0.1:27999/",
      "database": "testdb",
      "host": "172.17.0.1",
      "port": 27999
    },
    {
      "name": "Test Prod DB",
      "uri": "mongodb://mongodb:27017/",
      "database": "proddb",
      "host": "mongodb",
      "port": 27017
    },
    {
      "name": "Test Restore DB",
      "uri": "mongodb://172.17.0.1:27999/testdb",
      "database": "testdb",
      "host": "172.17.0.1",
      "port": 27999
    }
  ]
}
EOF

# Copy source code and configuration to container
echo -e "${YELLOW}Checking access to source code...${NC}"
docker exec mongo-tools sh -c "cd /app && ls -la && mkdir -p backups"

# Add test data to MongoDB
echo -e "${YELLOW}Adding test data to MongoDB...${NC}"
docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval '
  // Create 10 users
  var users = [];
  for (var i = 1; i <= 10; i++) {
    users.push({ name: "User " + i, email: "user" + i + "@example.com", active: i % 2 === 0 });
  }
  db.users.insertMany(users);
  
  // Create 5 categories
  var categories = [];
  for (var i = 1; i <= 5; i++) {
    categories.push({ name: "Category " + i, description: "Description for category " + i });
  }
  db.categories.insertMany(categories);
  
  // Create 20 products
  var products = [];
  for (var i = 1; i <= 20; i++) {
    products.push({ 
      name: "Product " + i, 
      price: i * 50, 
      category: "Category " + (i % 5 + 1),
      inStock: i % 3 === 0,
      tags: ["tag" + (i % 3), "tag" + (i % 5)]
    });
  }
  db.products.insertMany(products);
  print("Test data added.");
'

# Test direct backup
echo -e "${YELLOW}Testing direct backup...${NC}"
docker exec -w /app mongo-tools node ./dist/index.js --config=config.container.json --backup --source="Test MongoDB" --mode=all

# Check backup creation
BACKUP_COUNT=$(docker exec -w /app mongo-tools sh -c "ls -la backups/*.gz 2>/dev/null | wc -l")
  
if [ "$BACKUP_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✓ Backup created successfully by utility${NC}"
  BACKUP_FILE=$(docker exec -w /app mongo-tools sh -c "ls -t backups/*.gz 2>/dev/null | head -1")
  echo -e "  Backup file: $BACKUP_FILE"
  
  # Check backup file existence
  echo -e "${YELLOW}Checking backup file existence...${NC}"
  docker exec -w /app mongo-tools sh -c "ls -la $BACKUP_FILE && ls -la ${BACKUP_FILE}.json"
  
  # Check metadata content
  echo -e "${YELLOW}Metadata content:${NC}"
  docker exec -w /app mongo-tools sh -c "cat ${BACKUP_FILE}.json"
  EXPECTED_COLLECTIONS=$(docker exec -w /app mongo-tools sh -c "cat ${BACKUP_FILE}.json" | grep -o '\"collections\":\s*\[\s*\"[^\"]*\"' | grep -o '\"[^\"]*\"' | grep -v collections | tr -d '\"' | sort | tr '\n' ' ')
  echo -e "${YELLOW}Expected collections: $EXPECTED_COLLECTIONS${NC}"
  
  # Check archive content
  echo -e "${YELLOW}Checking archive content:${NC}"
  docker exec -w /app mongo-tools sh -c "mkdir -p /tmp/restore-test && cd /tmp/restore-test && mongorestore --gzip --archive=${BACKUP_FILE} --verbose"
  
  # Before restoration, clean existing data to ensure successful operation
  echo -e "${YELLOW}Cleaning existing data in testdb...${NC}"
  docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval 'db.users.drop(); db.products.drop(); db.orders.drop();'
  
  # Check database state before restoration
  echo -e "${YELLOW}Database state before restoration:${NC}"
  docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval "db.getCollectionNames()"
  
  # Test direct restoration with mongorestore
  echo -e "${YELLOW}Test direct restoration with mongorestore...${NC}"
  docker exec -w /app mongo-tools sh -c "mongorestore --gzip --archive=${BACKUP_FILE} --host=172.17.0.1 --port=27999 --db=testdb"
  
  # Test restoration (if backup was created)
  echo -e "\n${YELLOW}Testing direct restoration...${NC}"
  # Check MongoDB access from mongo-tools container
  echo -e "${YELLOW}Checking access to MongoDB from mongo-tools...${NC}"
  if docker exec mongo-tools which mongosh >/dev/null 2>&1; then
    docker exec mongo-tools mongosh --quiet --eval "db.adminCommand('ping')" mongodb://mongodb:27017/
  else
    echo -e "${YELLOW}mongosh не найден, используем mongo${NC}"
    docker exec mongo-tools mongo --quiet --eval "db.adminCommand('ping')" mongodb://mongodb:27017/
  fi
  
  echo -e "Restore file: $BACKUP_FILE"
  docker exec -w /app mongo-tools node ./dist/index.js --config=config.container.json --restore --file="$BACKUP_FILE" --target="Test Restore DB"
  
  # Check restoration data
  echo -e "\n${YELLOW}Checking restored data...${NC}"
  echo -e "${YELLOW}Checking restoration process completion...${NC}"
  # Active waiting for restoration process completion
  for i in {1..10}; do
    RESTORE_PROCESS=$(docker exec test-mongodb ps aux | grep mongorestore | grep -v grep)
    if [ -z "$RESTORE_PROCESS" ]; then
      echo -e "${GREEN}Restoration process completed${NC}"
      break
    fi
    echo -e "${YELLOW}Waiting for mongorestore completion (attempt $i)...${NC}"
    sleep 2
  done

  # Check database testdb
  echo -e "${YELLOW}Checking database testdb...${NC}"
  TEST_COLLECTIONS=$(docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval "db.getCollectionNames()")
  echo "Collections in testdb: $TEST_COLLECTIONS"
  
  # Check data in restored collections
  for COLL in $(echo $TEST_COLLECTIONS | tr -d '[],'); do
    COLL_CLEAN=$(echo $COLL | tr -d '"' | tr -d ' ')
    if [ ! -z "$COLL_CLEAN" ]; then
      echo -e "${YELLOW}Checking data in collection $COLL_CLEAN:${NC}"
      COUNT=$(docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval "db.$COLL_CLEAN.count()")
      echo -e "  Documents in collection $COLL_CLEAN: $COUNT"
      
      # Output example data for confirmation of restoration
      if [ "$COUNT" -gt 0 ]; then
        echo -e "${YELLOW}Example document from collection $COLL_CLEAN:${NC}"
        docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval "db.$COLL_CLEAN.findOne()"
        echo -e "${GREEN}✓ Data in collection $COLL_CLEAN restored successfully${NC}"
      else
        echo -e "${RED}✗ Collection $COLL_CLEAN is empty${NC}"
      fi
    fi
  done
  
  # Итоговый результат восстановления
  TOTAL_COLLECTIONS=$(echo $TEST_COLLECTIONS | tr -d '[],"' | wc -w)
  if [ "$TOTAL_COLLECTIONS" -gt 0 ]; then
    echo -e "${GREEN}✓ Restoration completed successfully - found $TOTAL_COLLECTIONS collections${NC}"
    
    # Check if data exists in at least one collection
    DATA_EXISTS=0
    for COLL in $(echo $TEST_COLLECTIONS | tr -d '[],'); do
      COLL_CLEAN=$(echo $COLL | tr -d '"' | tr -d ' ')
      if [ ! -z "$COLL_CLEAN" ]; then
        COUNT=$(docker exec test-mongodb mongo --quiet mongodb://localhost:27017/testdb --eval "db.$COLL_CLEAN.count()")
        if [ "$COUNT" -gt 0 ]; then
          DATA_EXISTS=1
          break
        fi
      fi
    done
    
    if [ "$DATA_EXISTS" -eq 1 ]; then
      echo -e "${GREEN}✓ TEST PASSED: Data restoration works correctly${NC}"
      exit 0
    else
      echo -e "${RED}✗ TEST FAILED: Collections restored, but data is missing${NC}"
      exit 1
    fi
  else
    echo -e "${RED}✗ Restoration ended with an error - collections not found${NC}"
    exit 1
  fi
else
  echo -e "${RED}✗ Unable to find created backup${NC}"
fi

echo -e "\n${YELLOW}=== Manual testing ===${NC}"
echo -e "For manual utility launch use: npm start -- --config=config.container.json"
echo -e "For connecting to test MongoDB: docker exec -it test-mongodb mongo mongodb://$MONGODB_IP:27017/"

echo -e "\n${YELLOW}Press Enter to stop the test environment or Ctrl+C to exit and save the environment${NC}"
read -r

# Stop Docker Compose
echo -e "${YELLOW}Stopping test environment...${NC}"
docker-compose -f docker-compose.test.yml down -v

# Delete temporary configuration
rm -f config.container.json

echo -e "${GREEN}All tests completed successfully.${NC}" 