const router=require('express').Router(); const c=require('../controllers/dashboardController'); router.get('/',c.index); module.exports=router;
